/**
 * OpenCode v2 TUI plugin implementation: builds a `TuiHostApi` adapter over
 * the v2 TUI plugin context so the unchanged explorer wizard (wizard.tsx)
 * runs on both hosts, and registers the palette/slash command.
 *
 * Dialog bridging: the v1 api exposes dialog components (DialogSelect, …)
 * that RETURN JSX rendered inside an enclosing `dialog.replace(render)`
 * entry. The v2 api only offers promise-based dialogs that open their own
 * host entry. The bridge reconciles the two: `replace()` invokes the render
 * thunk synchronously — if it returns renderable content the v2 dialog shows
 * it as one entry with the caller's onClose; if it returned nothing (because
 * a DialogX bridge already opened the host's own dialog), the caller's
 * onClose is parked and invoked when that nested dialog is dismissed without
 * a result (esc), which is exactly when v1 would have fired it.
 */

import { createSignal } from "solid-js"
import { declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"
import type { TuiHostApi, TuiHostKeymapLayer } from "./tui-host.js"
import { mainMenu } from "./wizard.js"
import type { V2KeymapCommand, V2KeymapLayer, V2TuiContext, V2TuiSetup } from "./v2-types.js"

function pickThemeToken(source: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * The wire `location` query uses `workspace`; the plugin-facing LocationRef
 * uses `workspaceID`. Translate at the boundary.
 */
function wireLocation(ref: { directory: string; workspaceID?: string } | undefined): Record<string, string> | undefined {
  if (!ref) return undefined
  return ref.workspaceID !== undefined ? { directory: ref.directory, workspace: ref.workspaceID } : { directory: ref.directory }
}

/** Wraps the v2 client so session.* calls carry the current location query
 * (v2 generated methods are flat; absent location keys default to the TUI's
 * own location, which is what the explorer wants). */
function withLocationQualifiedSessions(client: unknown, location: () => Record<string, string> | undefined): unknown {
  if (!client || typeof client !== "object") return client
  const session = (client as { session?: Record<string, unknown> }).session
  if (!session || typeof session !== "object") return client
  const wrapped: Record<string, unknown> = {}
  for (const method of ["list", "active", "status", "messages", "delete", "remove", "get", "wait"]) {
    const fn = (session as Record<string, unknown>)[method]
    if (typeof fn !== "function") continue
    const bound = fn.bind(session)
    wrapped[method] = (input: unknown) => {
      const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
      const loc = location()
      const merged = { ...loc, ...base }
      return bound(merged)
    }
  }
  return { ...((client as Record<string, unknown>) ?? {}), session: { ...session, ...wrapped } }
}

function buildV2Theme(context: V2TuiContext) {
  // Read theme/mode live inside the getter so mid-session theme switches
  // reach the wizard (the host resolves a fresh token set per change).
  return {
    get current() {
      const theme = context.theme
      const dark = context.themeMode === "dark"
      const text = pickThemeToken(theme, "text", "default")
      return {
        text,
        textMuted: pickThemeToken(theme, "text", "subdued") ?? text,
        background: pickThemeToken(theme, "background", "default"),
        backgroundPanel: pickThemeToken(theme, "background", "surface", "offset") ?? pickThemeToken(theme, "background", "default"),
        primary: pickThemeToken(theme, "text", "action", "primary", "selected") ?? text,
        secondary: pickThemeToken(theme, "hue", dark ? "interactive" : "neutral", dark ? 300 : 700) ?? text,
        accent: pickThemeToken(theme, "hue", "accent", dark ? 200 : 800) ?? text,
        success: pickThemeToken(theme, "text", "feedback", "success", "default") ?? text,
        warning: pickThemeToken(theme, "text", "feedback", "warning", "default") ?? text,
        error: pickThemeToken(theme, "text", "feedback", "error", "default") ?? text,
        info: pickThemeToken(theme, "text", "feedback", "info", "default") ?? text,
      }
    },
  }
}

function convertKeymapLayer(layer: TuiHostKeymapLayer): V2KeymapLayer {
  const bindingsByName = new Map<string, string[]>()
  for (const binding of layer.bindings ?? []) {
    if (!binding?.cmd) continue
    const keys = bindingsByName.get(binding.cmd) ?? []
    keys.push(binding.key)
    bindingsByName.set(binding.cmd, keys)
  }
  const commands: V2KeymapCommand[] = (layer.commands ?? []).map((command) => ({
    id: command.name,
    title: command.title ?? command.name,
    description: command.desc,
    ...(bindingsByName.get(command.name)?.length ? { bind: bindingsByName.get(command.name)!.join(",") } : {}),
    run: (_input?: string, event?: { preventDefault?: () => void; stopPropagation?: () => void }) =>
      command.run({ event: event ? { preventDefault: () => event.preventDefault?.(), stopPropagation: () => event.stopPropagation?.() } : undefined }),
  }))
  return { mode: "global", priority: layer.priority, commands }
}

/** Builds the v1-shaped `TuiHostApi` facade over a v2 TUI plugin context. */
export function buildV2HostApi(context: V2TuiContext): TuiHostApi {
  const disposeFns: Array<() => void> = []
  const locationRef = () => {
    try {
      return context.location
        ? (context.location as { directory: string; workspaceID?: string })
        : context.data.location.default()
    } catch {
      return undefined
    }
  }
  const wireLoc = () => wireLocation(locationRef())

  // --- kv: the explorer has no persisted settings; in-memory stub ---
  const kvMemory: Record<string, unknown> = {}
  const kv = {
    get<Value = unknown>(key: string, fallback?: Value): Value {
      return (kvMemory[key] === undefined ? fallback : kvMemory[key]) as Value
    },
    set(key: string, value: unknown) {
      kvMemory[key] = value
    },
    ready: true,
  }

  // --- v1-shaped live state over the v2 data stores ---
  const state = {
    get config() {
      // Hidden agents stay IN the record (flagged): the explorer shows
      // hidden/background subagent sessions, unlike selection UIs.
      const agents = context.data.location.agent.list() ?? []
      const agentRecord: Record<string, any> = {}
      for (const agent of agents) {
        agentRecord[agent.id] = {
          name: agent.name,
          mode: agent.mode,
          hidden: agent.hidden,
          color: agent.color,
        }
      }
      return { agent: agentRecord }
    },
    get provider() {
      return []
    },
    get path() {
      const dir = locationRef()?.directory ?? process.cwd()
      return { config: dir, directory: dir, worktree: dir }
    },
  }

  // --- dialog bridging (see module doc comment) ---
  const dialog = context.ui.dialog
  let nestedOnClose: (() => void) | undefined
  const settleNested = (dismissed: boolean) => {
    const onClose = nestedOnClose
    nestedOnClose = undefined
    if (dismissed) onClose?.()
  }

  const api: TuiHostApi = {
    hostVersion: 2,
    app: { version: context.app?.version },
    client: withLocationQualifiedSessions(context.client, wireLoc),
    kv,
    lifecycle: {
      onDispose(fn: () => void) {
        disposeFns.push(fn)
      },
    },
    mode: {
      push(mode: string) {
        try {
          return context.keymap.mode.push(mode)
        } catch {
          return () => undefined
        }
      },
    },
    renderer: {
      get root() {
        return (context.renderer as { root?: unknown } | undefined)?.root
      },
    },
    state,
    theme: buildV2Theme(context),
    ui: {
      toast: (input) => {
        try {
          context.ui.toast.show({ title: input.title, message: input.message, variant: input.variant, duration: input.duration })
        } catch {
          /* toasts must never crash the explorer */
        }
      },
      dialog: {
        replace(renderer: unknown, onClose?: () => void) {
          nestedOnClose = undefined
          let content: unknown
          try {
            content = typeof renderer === "function" ? (renderer as () => unknown)() : renderer
          } catch {
            content = undefined
          }
          if (content === undefined || content === null) {
            // A DialogX bridge opened the host's own dialog; esc/dismiss
            // paths settle through it instead of a dialog entry here.
            nestedOnClose = onClose
            return
          }
          const element = content
          dialog.show(() => element, onClose)
        },
        clear() {
          nestedOnClose = undefined
          dialog.clear()
        },
        setSize(size: string) {
          try {
            dialog.set({ size })
          } catch {
            /* size hints are best-effort */
          }
        },
      },
      DialogSelect(props) {
        void dialog
          .select({
            title: props.title,
            placeholder: props.placeholder,
            current: props.current,
            options: props.options.map((option) => ({
              title: option.title,
              value: option.value,
              description: option.description,
              category: option.category,
              disabled: option.disabled,
            })),
          })
          .then((value) => {
            if (value === undefined) {
              // v1 fires the enclosing dialog's onClose on esc.
              settleNested(true)
              return
            }
            settleNested(false)
            // v1's onSelect receives the full option object; the v2 dialog
            // resolves with the value, so recover the option it picked.
            const option = props.options.find((item) => item.value === value)
            if (option) props.onSelect(option)
          })
          .catch(() => settleNested(true))
      },
      DialogPrompt(props) {
        void dialog
          .prompt({ title: props.title, placeholder: props.placeholder, value: props.value })
          .then((value) => {
            settleNested(value === undefined)
            if (value === undefined) props.onCancel?.()
            else props.onConfirm(value)
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogConfirm(props) {
        void dialog
          .confirm({ title: props.title, message: props.message, label: { confirm: props.confirmLabel } })
          .then((result) => {
            settleNested(result !== true)
            if (result === true) props.onConfirm()
            else props.onCancel?.()
          })
          .catch(() => {
            settleNested(true)
            props.onCancel?.()
          })
      },
      DialogAlert(props) {
        void dialog
          .alert({ title: props.title, message: props.message })
          .then(() => {
            settleNested(false)
            props.onConfirm?.()
          })
          .catch(() => {
            settleNested(true)
            props.onConfirm?.()
          })
      },
    },
    keymap: {
      registerLayer(layer: TuiHostKeymapLayer) {
        // v2 layers are reactive: the input function re-evaluates when the
        // signal flips, so "unregistering" disables the layer. (The layer
        // computation itself lives until the host disposes the plugin — v2
        // has no per-layer unregister — but a disabled layer is inert.)
        const [active, setActive] = createSignal(true)
        try {
          context.keymap.layer(() =>
            active()
              ? convertKeymapLayer(layer)
              : { mode: "global", enabled: false, commands: [], bindings: [] },
          )
        } catch {
          return () => undefined
        }
        return () => {
          setActive(false)
        }
      },
    },
  }

  return api
}

/**
 * v2 TUI plugin setup: registers the palette/slash command (one reactive
 * keymap layer).
 */
export function createV2TuiSetup(): V2TuiSetup {
  return async (context: V2TuiContext) => {
    const api = buildV2HostApi(context)

    const command = {
      id: "subagent-explorer.open",
      title: "Subagent Explorer: Open",
      description: "Explore and delete subagent sessions",
      category: "",
      group: "",
      palette: true as const,
      slash: { name: "subagent-explorer" },
      run: () => void mainMenu(api),
    }
    command.category = command.group = declarePaletteCategory("Subagent Explorer", command)
    schedulePaletteReconcile()
    const [paletteActive, setPaletteActive] = createSignal(true)
    try {
      context.keymap.layer(() =>
        paletteActive()
          ? { mode: "global", commands: [command as V2KeymapCommand] }
          : { mode: "global", enabled: false, commands: [] },
      )
    } catch {
      /* command registration failure must not break the plugin */
    }

    return () => {
      setPaletteActive(false)
    }
  }
}
