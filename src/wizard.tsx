/** @jsxImportSource @opentui/solid */

/**
 * Subagent Explorer wizard library.
 *
 * The whole explorer TUI: session tree browser, detail view, deletion flows
 * and idle cleanup, for the current session's subagent tree (nested children
 * included, hidden/background agents flagged).
 *
 * The thin plugin entry lives in tui.tsx; embedding hosts (Config Studio)
 * import mainMenu from here and drive it with their own TuiHostApi instance.
 */

import type { TuiHostApi as TuiPluginApi } from "./tui-host.js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  buildSessionTree,
  cleanupTargets,
  configAgentIDs,
  currentSessionID,
  deleteSession,
  fetchActiveSessionIDs,
  fetchSessionDetails,
  fetchSessions,
  fetchVariantAttribution,
  formatAge,
  hiddenAgentIDs,
  loadAvSidecar,
  parentCandidates,
  rowHidden,
  type CleanupPlan,
  type SessionLite,
  type SessionTreeNode,
  type VariantAttribution,
} from "./sessions.js"

export type ExplorerRow = {
  session: SessionLite
  depth: number
  running: boolean
  hidden: boolean
  variant?: { alias: string; parent: string }
}

export type ExplorerData = {
  sessions: SessionLite[]
  activeIDs: Set<string> | undefined
  activeKnown: boolean
  hidden: Set<string>
  configAgents: Set<string>
  /** child session id -> creating AV variant (recent history only). */
  variantOf: VariantAttribution
  /** AV sidecar parents (empty when agent-variants is not installed). */
  avParents: Map<string, { disableBase: boolean }>
}

export type TreeAction =
  | { type: "delete"; row: ExplorerRow }
  | { type: "details"; row: ExplorerRow }
  | { type: "cleanup" }
  | { type: "refresh" }
  | { type: "switch-root" }
  | { type: "size" }
  | { type: "exit" }

function globalConfigDirOf(api: TuiPluginApi): string | undefined {
  const config = api.state.path?.config
  if (!config) return undefined
  const index = Math.max(config.lastIndexOf("/"), config.lastIndexOf("\\"))
  return index > 0 ? config.slice(0, index) : undefined
}

export async function loadExplorerData(api: TuiPluginApi, directory: string, rootOverride?: string): Promise<ExplorerData | undefined> {
  const sessions = await fetchSessions(api.client, directory)
  if (!sessions) return undefined
  const [activeIDs, avSidecar] = await Promise.all([
    fetchActiveSessionIDs(api.client),
    Promise.resolve(loadAvSidecar(globalConfigDirOf(api))),
  ])
  const rootID = rootOverride ?? currentSessionID(api.currentSessionID?.(), sessions)
  const variantOf = await fetchVariantAttribution(api.client, rootID, directory, new Set(avSidecar.parents.keys()))
  return {
    sessions,
    activeIDs,
    activeKnown: activeIDs !== undefined,
    hidden: hiddenAgentIDs(api.state.config),
    configAgents: configAgentIDs(api.state.config),
    variantOf,
    avParents: avSidecar.parents,
  }
}

export function explorerRows(tree: SessionTreeNode[], data: ExplorerData): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const node of nodes) {
      const variant = data.variantOf.get(node.session.id)
      const agent = node.session.agent
      rows.push({
        session: node.session,
        depth,
        running: data.activeIDs?.has(node.session.id) ?? false,
        // Badge decision is window-independent (see rowHidden): children of
        // AV-managed parents are never badged, attributed or not.
        hidden: rowHidden(variant, agent, data.avParents, data.hidden, data.configAgents),
        variant,
      })
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return rows
}

export function agentLabelOf(row: Pick<ExplorerRow, "session" | "variant">): string {
  return row.variant?.alias ?? row.session.agent ?? "unknown"
}

function themeOf(api: TuiPluginApi) {
  return api.theme.current
}

// ---------------------------------------------------------------------------
// Dialog sizing (same conventions as Config Studio / Agent Variants)
// ---------------------------------------------------------------------------

type DialogSize = "medium" | "large" | "xlarge"

const OWN_SIZE_KV = "subagent-explorer.ui-width"
const OWN_HEIGHT_PERCENT_KV = "subagent-explorer.ui-height-percent"
const HOST_SIZE_KV = "config-studio.ui-width"
const HOST_HEIGHT_PERCENT_KV = "config-studio.ui-height-percent"
const HEIGHT_PERCENT_MIN = 25
const HEIGHT_PERCENT_MAX = 100
const HEIGHT_PRESETS = [
  { key: "1", label: "compact", value: 35 },
  { key: "2", label: "normal", value: 50 },
  { key: "3", label: "tall", value: 70 },
  { key: "4", label: "max", value: 100 },
] as const
const DIALOG_WIDTH_COLUMNS: Record<DialogSize, number> = { medium: 60, large: 88, xlarge: 116 }

function isEmbedded(api: TuiPluginApi): boolean {
  return (api as TuiPluginApi & { dialogScope?: "standalone" | "embedded" }).dialogScope === "embedded"
}

function sizeKey(api: TuiPluginApi): string {
  return isEmbedded(api) ? HOST_SIZE_KV : OWN_SIZE_KV
}

function heightKey(api: TuiPluginApi): string {
  return isEmbedded(api) ? HOST_HEIGHT_PERCENT_KV : OWN_HEIGHT_PERCENT_KV
}

function dialogSizeOf(api: TuiPluginApi): DialogSize {
  const value = api.kv.get<DialogSize>(sizeKey(api), "large")
  if (value === "medium" || value === "large" || value === "xlarge") return value
  return "large"
}

function setDialogSize(api: TuiPluginApi, size: DialogSize) {
  api.kv.set(sizeKey(api), size)
  api.ui.dialog.setSize(size)
}

function nextDialogSize(api: TuiPluginApi): DialogSize {
  const current = dialogSizeOf(api)
  if (current === "medium") return "large"
  if (current === "large") return "xlarge"
  return "medium"
}

function clampHeightPercent(value: number) {
  return Math.max(HEIGHT_PERCENT_MIN, Math.min(HEIGHT_PERCENT_MAX, Math.round(value)))
}

function dialogHeightPercent(api: TuiPluginApi): number {
  const value = api.kv.get<number>(heightKey(api), 50)
  return typeof value === "number" && Number.isFinite(value) ? clampHeightPercent(value) : 50
}

function setDialogHeightPercent(api: TuiPluginApi, value: number) {
  api.kv.set(heightKey(api), clampHeightPercent(value))
}

function useDialogSize(api: TuiPluginApi) {
  createEffect(() => api.ui.dialog.setSize(dialogSizeOf(api)))
}

/**
 * Pure dialog-height budget (same math as Config Studio's computeDialogRows):
 * OpenCode's dialog backdrop anchors at terminalHeight / 4, so a panel
 * taller than 75% of the terminal overflows the bottom edge. The percent
 * drives the request; the backdrop budget caps it.
 */
export function computeDialogRows(percent: number, terminalHeight: number, chromeRows: number, minRows: number) {
  const clampedPercent = Math.min(100, Math.max(10, Math.max(1, Math.round(percent)) || 1))
  const backdropBudget = Math.max(minRows + chromeRows, Math.floor(terminalHeight * 0.75) - 1)
  const available = Math.max(minRows, backdropBudget - chromeRows)
  const requested = Math.max(minRows, Math.floor((terminalHeight * clampedPercent) / 100) - chromeRows)
  return { availableRows: available, targetRows: Math.min(requested, available) }
}

function listRows(api: TuiPluginApi, terminalHeight: number, chromeRows = 8, minRows = 3): number {
  return computeDialogRows(dialogHeightPercent(api), terminalHeight, chromeRows, minRows).targetRows
}

/** Content width for width-aware column truncation. */
function contentWidth(api: TuiPluginApi): number {
  return DIALOG_WIDTH_COLUMNS[dialogSizeOf(api)] - 8
}

function cappedHeight(count: number, max: number, min = 1): number {
  return Math.max(min, Math.min(count, max))
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export function rowTitle(row: ExplorerRow): string {
  return row.session.title ?? row.session.id
}

function showTreeOnce(api: TuiPluginApi, props: { rows: ExplorerRow[]; rootTitle: string; rootID: string; activeKnown: boolean; idleCount: number }): Promise<TreeAction | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: TreeAction | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <SubagentTreeDialog api={api} rows={props.rows} rootTitle={props.rootTitle} rootID={props.rootID} activeKnown={props.activeKnown} idleCount={props.idleCount} onDone={done} />,
      () => done({ type: "exit" }, false),
    )
  })
}

export function SubagentTreeDialog(props: {
  api: TuiPluginApi
  rows: ExplorerRow[]
  rootTitle: string
  rootID: string
  activeKnown: boolean
  idleCount: number
  onDone: (value: TreeAction | undefined) => void
}) {
  const theme = () => themeOf(props.api)
  const dimensions = useTerminalDimensions()
  useDialogSize(props.api)
  const popMode = props.api.mode.push("subagent-explorer.dialog")
  const [selected, setSelected] = createSignal(0)
  const current = createMemo(() => props.rows[selected()])
  let scroll: ScrollBoxRenderable | undefined
  const listHeight = createMemo(() => cappedHeight(props.rows.length, listRows(props.api, dimensions().height)))
  const agentWidth = 16
  const badgeWidth = 9
  const ageWidth = 9
  const titleWidth = createMemo(() => Math.max(16, contentWidth(props.api) - agentWidth - badgeWidth - ageWidth - 4))
  const move = (delta: number) =>
    setSelected((value) => {
      const next = Math.max(0, Math.min(props.rows.length - 1, value + delta))
      scroll?.scrollTo(Math.max(0, next - 2))
      return next
    })
  const choose = () => {
    const row = current()
    if (row) props.onDone({ type: "delete", row })
  }
  const details = () => {
    const row = current()
    if (row) props.onDone({ type: "details", row })
  }
  const commandPrefix = `subagent-explorer.tree.${Math.random().toString(36).slice(2)}`
  const shield = (ctx: { event?: { preventDefault?: () => void; stopPropagation?: () => void } }) => {
    ctx.event?.preventDefault?.()
    ctx.event?.stopPropagation?.()
  }
  const commands = [
    { name: `${commandPrefix}.up`, title: "Previous", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(-1) } },
    { name: `${commandPrefix}.down`, title: "Next", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(1) } },
    { name: `${commandPrefix}.select`, title: "Delete session", run: () => choose() },
    { name: `${commandPrefix}.details`, title: "Session details", run: () => details() },
    { name: `${commandPrefix}.cleanup`, title: "Clean up idle sessions", run: () => props.onDone({ type: "cleanup" }) },
    { name: `${commandPrefix}.refresh`, title: "Refresh", run: () => props.onDone({ type: "refresh" }) },
    { name: `${commandPrefix}.switch`, title: "Switch root session", run: () => props.onDone({ type: "switch-root" }) },
    ...(isEmbedded(props.api) ? [] : [{ name: `${commandPrefix}.size`, title: "Dialog size", run: () => props.onDone({ type: "size" } as TreeAction) }]),
    { name: `${commandPrefix}.back`, title: "Exit", run: () => props.onDone({ type: "exit" }) },
  ]
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands,
    bindings: [
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Previous" },
      { key: "ctrl+p", cmd: `${commandPrefix}.up`, desc: "Previous" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Next" },
      { key: "ctrl+n", cmd: `${commandPrefix}.down`, desc: "Next" },
      { key: "enter", cmd: `${commandPrefix}.select`, desc: "Delete" },
      { key: "i", cmd: `${commandPrefix}.details`, desc: "Details" },
      { key: "c", cmd: `${commandPrefix}.cleanup`, desc: "Cleanup idle" },
      { key: "r", cmd: `${commandPrefix}.refresh`, desc: "Refresh" },
      { key: "s", cmd: `${commandPrefix}.switch`, desc: "Switch root" },
      ...(isEmbedded(props.api) ? [] : [{ key: "o", cmd: `${commandPrefix}.size`, desc: "Dialog size" }]),
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Exit" },
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  const runningCount = props.rows.filter((row) => row.running).length
  const hiddenCount = props.rows.filter((row) => row.hidden).length
  const statusLabel = props.activeKnown ? (runningCount > 0 ? `${runningCount} running` : "none running") : "status unknown"

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().text}><b>{`Subagent sessions — ${truncate(props.rootTitle, 40)}`}</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone({ type: "exit" })}>esc exit</text>
      </box>
      <box flexDirection="row" gap={3} marginBottom={1}>
        <text fg={theme().textMuted}>{`${props.rows.length} session(s)`}</text>
        <text fg={runningCount > 0 ? theme().success : theme().textMuted}>{statusLabel}</text>
        <Show when={hiddenCount > 0}>
          <text fg={theme().warning}>{`${hiddenCount} hidden`}</text>
        </Show>
        <text fg={theme().textMuted}>{`${props.idleCount} idle`}</text>
      </box>
      <scrollbox maxHeight={listHeight()} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
        <box flexDirection="column" gap={0}>
          <Show
            when={props.rows.length > 0}
            fallback={
              <box flexDirection="row" paddingLeft={1} paddingTop={1} paddingBottom={1}>
                <text fg={theme().textMuted}>{"No subagent sessions in this session's tree."}</text>
              </box>
            }
          >
            <For each={props.rows}>
              {(row, index) => {
                const active = createMemo(() => selected() === index())
                const titleFg = createMemo(() => (active() ? theme().background : row.running ? theme().success : row.hidden ? theme().textMuted : theme().text))
                const badgeFg = createMemo(() => (active() ? theme().background : theme().warning))
                return (
                  <box
                    flexDirection="row"
                    width="100%"
                    gap={1}
                    paddingLeft={1 + row.depth * 2}
                    paddingRight={1}
                    backgroundColor={active() ? theme().primary : theme().backgroundPanel}
                    onMouseOver={() => setSelected(index())}
                    onMouseUp={() => props.onDone({ type: "delete", row })}
                  >
                    <text fg={titleFg()} flexShrink={0}>{row.running ? "▶" : "·"}</text>
                    <text width={agentWidth} flexShrink={0} fg={active() ? theme().background : theme().textMuted} wrapMode="none" overflow="hidden"><b>{truncate(agentLabelOf(row), agentWidth)}</b></text>
                    <Show when={row.hidden}>
                      <text width={badgeWidth} flexShrink={0} fg={badgeFg()} wrapMode="none" overflow="hidden">{"[hidden]"}</text>
                    </Show>
                    <text width={titleWidth()} flexGrow={1} fg={titleFg()} wrapMode="none" overflow="hidden">{truncate(rowTitle(row), titleWidth())}</text>
                    <text width={ageWidth} flexShrink={0} fg={active() ? theme().background : theme().textMuted} wrapMode="none" overflow="hidden">{formatAge(row.session.updated ?? row.session.created)}</text>
                  </box>
                )
              }}
            </For>
          </Show>
        </box>
      </scrollbox>
      <box flexDirection="row" gap={3} marginTop={1}>
        <text fg={theme().textMuted}>enter delete</text>
        <text fg={theme().textMuted}>i details</text>
        <text fg={theme().textMuted}>c cleanup idle</text>
        <text fg={theme().textMuted}>r refresh</text>
        <text fg={theme().textMuted}>s switch session</text>
        <Show when={!isEmbedded(props.api)}>
          <text fg={theme().textMuted}>o size</text>
        </Show>
      </box>
    </box>
  )
}

function showDangerConfirm(api: TuiPluginApi, props: { title: string; message: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <DangerConfirmDialog api={api} title={props.title} message={props.message} confirmLabel={props.confirmLabel} onDone={done} />,
      () => done(false),
    )
  })
}

function DangerConfirmDialog(props: { api: TuiPluginApi; title: string; message: string; confirmLabel: string; onDone: (value: boolean) => void }) {
  const theme = () => themeOf(props.api)
  useDialogSize(props.api)
  const popMode = props.api.mode.push("subagent-explorer.confirm")
  const commandPrefix = `subagent-explorer.confirm.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.confirm`, title: "Confirm", run: () => props.onDone(true) },
      { name: `${commandPrefix}.cancel`, title: "Cancel", run: () => props.onDone(false) },
    ],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.confirm`, desc: "Confirm" },
      { key: "escape", cmd: `${commandPrefix}.cancel`, desc: "Cancel" },
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })
  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <text fg={theme().error}><b>{props.title}</b></text>
      <text fg={theme().text}>{props.message}</text>
      <box flexDirection="row" gap={4} marginTop={1}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().error} onMouseUp={() => props.onDone(true)}>
          <text fg={theme().background}><b>{props.confirmLabel}</b></text>
        </box>
        <box paddingLeft={1} paddingRight={1} onMouseUp={() => props.onDone(false)}>
          <text fg={theme().textMuted}>{"Cancel (esc)"}</text>
        </box>
      </box>
    </box>
  )
}

function showInfo(api: TuiPluginApi, props: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(() => <InfoDialog api={api} title={props.title} message={props.message} onDone={done} />, done)
  })
}

function InfoDialog(props: { api: TuiPluginApi; title: string; message: string; onDone: () => void }) {
  const theme = () => themeOf(props.api)
  const dimensions = useTerminalDimensions()
  useDialogSize(props.api)
  const popMode = props.api.mode.push("subagent-explorer.info")
  const commandPrefix = `subagent-explorer.info.${Math.random().toString(36).slice(2)}`
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [{ name: `${commandPrefix}.done`, title: "Close", run: () => props.onDone() }],
    bindings: [
      { key: "enter", cmd: `${commandPrefix}.done`, desc: "Close" },
      { key: "escape", cmd: `${commandPrefix}.done`, desc: "Close" },
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })
  const lines = props.message.split("\n")
  const maxHeight = cappedHeight(lines.length, listRows(props.api, dimensions().height, 6, 3))
  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text fg={theme().text}><b>{props.title}</b></text>
      <scrollbox maxHeight={maxHeight} marginTop={1}>
        <box flexDirection="column" gap={0}>
          <For each={lines}>
            {(line) => <text fg={line.startsWith("!!") ? theme().error : theme().text}>{line.replace(/^!!/, "")}</text>}
          </For>
        </box>
      </scrollbox>
      <box flexDirection="row" gap={3} marginTop={1}>
        <text fg={theme().textMuted}>enter/esc close</text>
      </box>
    </box>
  )
}

function showConfirm(api: TuiPluginApi, props: { title: string; message: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title: props.title,
          message: props.message,
          onConfirm: () => done(true),
          onCancel: () => done(false),
        }),
      () => done(false),
    )
  })
}

async function deleteOne(api: TuiPluginApi, row: ExplorerRow): Promise<boolean> {
  const label = `${rowTitle(row)}${row.hidden ? " [hidden agent]" : ""}`
  const summary = `${label}\n${row.variant ? `variant: ${row.variant.alias} (of ${row.variant.parent})` : `agent: ${row.session.agent ?? "unknown"}`}\nlast activity: ${formatAge(row.session.updated ?? row.session.created)}\n\nDeleting a session permanently removes it, its messages, and its history. The parent session keeps the task result text; only the jump target is lost.`
  const confirmed = row.running
    ? await showDangerConfirm(api, {
        title: "Delete RUNNING subagent session?",
        message: `${summary}\n\n!!This session is running right now. Deleting it interrupts the work in progress.`,
        confirmLabel: "Delete anyway",
      })
    : await showConfirm(api, { title: "Delete subagent session?", message: summary })
  if (!confirmed) return false
  const ok = await deleteSession(api.client, row.session.id)
  api.ui.toast({
    variant: ok ? "default" : "error",
    title: ok ? "Session deleted" : "Delete failed",
    message: ok ? label : `Could not delete ${label} — the host client exposes no working session delete.`,
  })
  return ok
}

function CleanupProgressDialog(props: { api: TuiPluginApi; done: () => number; total: number }) {
  const theme = () => themeOf(props.api)
  const popMode = props.api.mode.push("subagent-explorer.cleanup")
  onCleanup(() => popMode())
  const done = props.done
  const total = props.total
  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={2} gap={1}>
      <text fg={theme().text}><b>{`Cleaning up idle subagent sessions…`}</b></text>
      <text fg={theme().textMuted}>{`${done()} / ${total} deleted`}</text>
      <text fg={theme().textMuted}>{"This dialog closes when the batch finishes."}</text>
    </box>
  )
}

function showCleanupProgress(api: TuiPluginApi, done: () => number, total: number): void {
  api.ui.dialog.replace(() => <CleanupProgressDialog api={api} done={done} total={total} />, () => {})
}

async function runCleanup(api: TuiPluginApi, plan: CleanupPlan, rootTitle: string, directory: string, rootID: string): Promise<number> {
  if (plan.deletable.length === 0) {
    await showInfo(api, {
      title: "Nothing to clean up",
      message: plan.sparedActive.length > 0 ? `All ${plan.sparedActive.length} subagent session(s) are running right now.` : "There are no subagent sessions in this session's tree.",
    })
    return 0
  }
  const runningNote = plan.sparedActive.length > 0 ? `\n\n${plan.sparedActive.length} running session(s) will be spared.` : ""
  const confirmed = await showDangerConfirm(api, {
    title: `Delete ${plan.deletable.length} idle subagent session(s)?`,
    message: `Permanently deletes every idle subagent session in "${truncate(rootTitle, 40)}"'s tree (nested children included), with all messages and history.${runningNote}`,
    confirmLabel: "Delete idle sessions",
  })
  if (!confirmed) return 0
  let deleted = 0
  const [progressDone, setProgressDone] = createSignal(0)
  showCleanupProgress(api, progressDone, plan.deletable.length)
  for (const session of plan.deletable) {
    if (await deleteSession(api.client, session.id)) {
      deleted += 1
      setProgressDone(deleted)
    }
  }
  // Verify against a fresh (full, un-capped) fetch: the server's remove
  // handler swallows internal errors and still answers, and the host may
  // spawn new children while we work - report what actually remains.
  const remainingIdle = await remainingIdleCount(api, directory, rootID)
  api.ui.dialog.clear()
  const failed = plan.deletable.length - deleted
  api.ui.toast({
    variant: failed > 0 || remainingIdle > 0 ? "warning" : "default",
    title: "Cleanup finished",
    message:
      remainingIdle > 0
        ? `Deleted ${deleted}. ${remainingIdle} idle session(s) still remain${failed > 0 ? ` (${failed} delete call(s) failed - re-run cleanup or delete rows individually)` : " - re-run cleanup for the newly-idle"}.`
        : failed > 0
          ? `Deleted ${deleted}, failed ${failed}.`
          : `Deleted ${deleted} session(s).`,
  })
  return deleted
}

async function remainingIdleCount(api: TuiPluginApi, directory: string, rootID: string): Promise<number> {
  const sessions = await fetchSessions(api.client, directory)
  if (!sessions) return 0
  const active = await fetchActiveSessionIDs(api.client)
  const rows = explorerRows(buildSessionTree(sessions, rootID), {
    sessions,
    activeIDs: active,
    activeKnown: active !== undefined,
    hidden: new Set(),
    configAgents: new Set(),
    variantOf: new Map(),
    avParents: new Map(),
  })
  return rows.filter((row) => !row.running).length
}

function showRootPicker(api: TuiPluginApi, sessions: SessionLite[], currentRoot: string | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    const options = parentCandidates(sessions)
      .slice(0, 200)
      .map((session) => ({
        title: truncate(session.title ?? session.id, 48),
        value: session.id,
        description: `${session.agent ?? "agent"} · ${formatAge(session.updated ?? session.created)}${session.id === currentRoot ? " · current" : ""}`,
      }))
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: "Explore which session's subagents?",
          placeholder: "Sessions that have subagents",
          options,
          current: currentRoot,
          onSelect: (option) => done(option.value),
        }),
      () => done(undefined),
    )
  })
}

async function showDetails(api: TuiPluginApi, row: ExplorerRow, data: ExplorerData): Promise<void> {
  const details = await fetchSessionDetails(api.client, row.session.id)
  const parentAgent = row.session.agent ?? "unknown"
  const lines = [
    `title: ${rowTitle(row)}`,
    row.variant
      ? `variant: ${row.variant.alias} (of ${row.variant.parent})`
      : `agent: ${parentAgent}${row.hidden ? " (hidden/background)" : ""}`,
  ]
  if (row.variant) {
    const parentEntry = data.avParents.get(row.variant.parent)
    if (parentEntry) {
      lines.push(`base ${row.variant.parent}: ${parentEntry.disableBase ? "disabled (variants only)" : "enabled"}`)
    }
  } else if (data.avParents.has(parentAgent)) {
    lines.push(`base ${parentAgent}: ${data.avParents.get(parentAgent)?.disableBase ? "disabled (variants only)" : "enabled"}`)
  }
  lines.push(
    `session: ${row.session.id}`,
    `status: ${row.running ? "running" : "idle"}`,
    `created: ${formatAge(row.session.created)}`,
    `last activity: ${formatAge(row.session.updated ?? row.session.created)}`,
  )
  if (details) {
    lines.push(`messages: ${details.messageCount}`)
    if (details.model) lines.push(`last model: ${details.model}`)
  } else {
    lines.push("messages: unknown (host client does not expose message listing)")
  }
  if (details?.firstPrompt) {
    lines.push("")
    lines.push("first prompt:")
    lines.push(details.firstPrompt)
  }
  await showInfo(api, { title: "Subagent session", message: lines.join("\n") })
}

// ---------------------------------------------------------------------------
// Dialog size picker (same picker as Config Studio / Agent Variants)
// ---------------------------------------------------------------------------

type SizeSliderChoice = { action: "save" | "custom-height"; height: number }

function showPrompt(api: TuiPluginApi, props: { title: string; placeholder?: string; value?: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
      api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title: props.title,
          placeholder: props.placeholder,
          value: props.value,
          onConfirm: (value) => done(value),
          onCancel: () => done(undefined),
        }),
      () => done(undefined),
    )
  })
}

async function showSizeSlider(api: TuiPluginApi): Promise<SizeSliderChoice | undefined> {
  let current = dialogHeightPercent(api)
  while (true) {
    const choice = await showSizeSliderOnce(api, current)
    if (!choice) return undefined
    current = choice.height
    if (choice.action === "save") return choice

    const input = await showPrompt(api, {
      title: "Dialog height percent",
      placeholder: `${HEIGHT_PERCENT_MIN}-${HEIGHT_PERCENT_MAX}`,
      value: String(current),
    })
    if (input === undefined) continue
    const value = Number(input)
    if (!Number.isFinite(value)) {
      await showInfo(api, { title: "Invalid height", message: `Enter a number from ${HEIGHT_PERCENT_MIN} to ${HEIGHT_PERCENT_MAX}.` })
      continue
    }
    current = clampHeightPercent(value)
  }
}

function showSizeSliderOnce(api: TuiPluginApi, current: number): Promise<SizeSliderChoice | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: SizeSliderChoice | undefined, clear = true) => {
      if (settled) return
      settled = true
      resolve(value)
      if (clear) api.ui.dialog.clear()
    }
    api.ui.dialog.replace(
      () => <SizeSliderDialog api={api} current={current} onDone={done} />,
      () => done(undefined, false),
    )
  })
}

function SizeSliderDialog(props: { api: TuiPluginApi; current: number; onDone: (value: SizeSliderChoice | undefined) => void }) {
  const theme = () => themeOf(props.api)
  const dimensions = useTerminalDimensions()
  useDialogSize(props.api)
  const [height, setHeight] = createSignal(clampHeightPercent(props.current))
  const popMode = props.api.mode.push("subagent-explorer.size")
  const commandPrefix = `subagent-explorer.size.${Math.random().toString(36).slice(2)}`

  const cycleWidth = () => setDialogSize(props.api, nextDialogSize(props.api))
  const setPreset = (preset: string) => {
    const found = HEIGHT_PRESETS.find((item) => item.label === preset)
    if (found) setHeight(found.value)
  }
  const move = (delta: number) => setHeight((value) => clampHeightPercent(value + delta))

  const sliderWidth = createMemo(() => (dialogSizeOf(props.api) === "xlarge" ? 64 : dialogSizeOf(props.api) === "large" ? 48 : 34))
  const sliderCells = createMemo(() => {
    const width = sliderWidth()
    const selected = Math.round(((height() - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1))
    const presetPositions = new Map(HEIGHT_PRESETS.map((preset) => [Math.round(((preset.value - HEIGHT_PERCENT_MIN) / (HEIGHT_PERCENT_MAX - HEIGHT_PERCENT_MIN)) * (width - 1)), preset.label]))
    return Array.from({ length: width }, (_, index) => {
      const isCurrent = index === selected
      const preset = presetPositions.get(index)
      return {
        char: isCurrent ? "●" : preset ? "│" : index < selected ? "━" : "─",
        color: isCurrent ? theme().primary : preset ? theme().accent : index < selected ? theme().success : theme().textMuted,
      }
    })
  })

  /** Live mini preview: a mock dialog box scaled to the current settings.
   * Uses computeDialogRows so the preview shows the TRUE capped height. */
  const preview = createMemo(() => {
    const widthColumns = DIALOG_WIDTH_COLUMNS[dialogSizeOf(props.api)]
    const previewWidth = Math.max(10, Math.min(sliderWidth() + 4, 72))
    const scale = previewWidth / widthColumns
    const metrics = computeDialogRows(height(), dimensions().height, 6, 4)
    const effective = metrics.targetRows
    const requested = Math.floor((dimensions().height * Math.min(100, Math.max(25, height()))) / 100)
    const rows = Math.max(4, Math.round(effective * scale))
    const fill = (text: string, width: number) => {
      const inner = width - 2
      const slice = text.length > inner ? text.slice(0, inner - 1) + "…" : text
      return `│${slice}${" ".repeat(Math.max(0, inner - slice.length))}│`
    }
    const lines: string[] = []
    lines.push(`┌${"─".repeat(previewWidth - 2)}┐`)
    lines.push(fill(`Subagent Explorer (preview)${effective < requested ? " [capped]" : ""}`, previewWidth))
    for (let index = 0; index < rows - 3; index++) lines.push(fill("", previewWidth))
    lines.push(`└${"─".repeat(previewWidth - 2)}┘`)
    return lines
  })

  const shield = (ctx: { event?: { preventDefault?: () => void; stopPropagation?: () => void } }) => {
    ctx.event?.preventDefault?.()
    ctx.event?.stopPropagation?.()
  }
  const unregister = props.api.keymap.registerLayer({
    priority: 10000,
    commands: [
      { name: `${commandPrefix}.width`, title: "Cycle width", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); cycleWidth() } },
      { name: `${commandPrefix}.left`, title: "Lower height", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(-1) } },
      { name: `${commandPrefix}.right`, title: "Raise height", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(1) } },
      { name: `${commandPrefix}.down`, title: "Lower height faster", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(-5) } },
      { name: `${commandPrefix}.up`, title: "Raise height faster", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); move(5) } },
      { name: `${commandPrefix}.compact`, title: "Compact preset", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); setPreset("compact") } },
      { name: `${commandPrefix}.normal`, title: "Normal preset", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); setPreset("normal") } },
      { name: `${commandPrefix}.tall`, title: "Tall preset", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); setPreset("tall") } },
      { name: `${commandPrefix}.max`, title: "Max preset", run: (ctx: Parameters<typeof shield>[0]) => { shield(ctx); setPreset("max") } },
      { name: `${commandPrefix}.custom`, title: "Custom percent", run: () => props.onDone({ action: "custom-height", height: height() }) },
      { name: `${commandPrefix}.save`, title: "Save", run: () => { setDialogHeightPercent(props.api, height()); props.onDone({ action: "save", height: height() }) } },
      { name: `${commandPrefix}.back`, title: "Back", run: () => props.onDone(undefined) },
    ],
    bindings: [
      { key: "w", cmd: `${commandPrefix}.width`, desc: "Cycle width" },
      { key: "left", cmd: `${commandPrefix}.left`, desc: "Lower height" },
      { key: "right", cmd: `${commandPrefix}.right`, desc: "Raise height" },
      { key: "down", cmd: `${commandPrefix}.down`, desc: "Lower height faster" },
      { key: "up", cmd: `${commandPrefix}.up`, desc: "Raise height faster" },
      { key: "1", cmd: `${commandPrefix}.compact`, desc: "Compact preset" },
      { key: "2", cmd: `${commandPrefix}.normal`, desc: "Normal preset" },
      { key: "3", cmd: `${commandPrefix}.tall`, desc: "Tall preset" },
      { key: "4", cmd: `${commandPrefix}.max`, desc: "Max preset" },
      { key: "c", cmd: `${commandPrefix}.custom`, desc: "Custom percent" },
      { key: "enter", cmd: `${commandPrefix}.save`, desc: "Save" },
      { key: "escape", cmd: `${commandPrefix}.back`, desc: "Back" },
    ],
  })
  onCleanup(() => {
    unregister()
    popMode()
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
        <text fg={theme().accent}><b>Dialog size</b></text>
        <text fg={theme().textMuted} onMouseUp={() => props.onDone(undefined)}>esc</text>
      </box>
      <box flexDirection="row" gap={0} width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>Width: </text>
        <text fg={theme().primary}><b>{dialogSizeOf(props.api)}</b></text>
        <text fg={theme().textMuted}> ({DIALOG_WIDTH_COLUMNS[dialogSizeOf(props.api)]} cols, w to cycle)   Height: </text>
        <text fg={theme().primary}><b>{height()}%</b></text>
      </box>
      <box flexDirection="row" width="100%" marginBottom={1}>
        <text fg={theme().textMuted}>{HEIGHT_PERCENT_MIN}% </text>
        <For each={sliderCells()}>{(cell) => <text fg={cell.color}>{cell.char}</text>}</For>
        <text fg={theme().textMuted}> {HEIGHT_PERCENT_MAX}%</text>
      </box>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <box flexDirection="column" gap={0}>
          <For each={HEIGHT_PRESETS}>
            {(preset) => <text fg={height() === preset.value ? theme().primary : theme().textMuted}>{preset.key} {preset.label}: {preset.value}%</text>}
          </For>
          <text fg={theme().textMuted}> </text>
          <text fg={theme().textMuted}>left/right 1%</text>
          <text fg={theme().textMuted}>up/down 5%</text>
          <text fg={theme().textMuted}>c custom</text>
        </box>
        <box flexDirection="column" gap={0}>
          <For each={preview()}>
            {(line) => <text fg={theme().textMuted}>{line}</text>}
          </For>
        </box>
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme().textMuted}>enter save</text>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme().primary} onMouseUp={() => { setDialogHeightPercent(props.api, height()); props.onDone({ action: "save", height: height() }) }}>
          <text fg={theme().background}><b>save</b></text>
        </box>
      </box>
    </box>
  )
}

/** The explorer entry point: runs the tree browser loop until the user exits. */
export async function mainMenu(api: TuiPluginApi): Promise<void> {
  const directory = api.state.path?.directory ?? api.state.path?.worktree ?? ""
  if (!directory) {
    await showInfo(api, { title: "Subagent Explorer", message: "No project directory is available from the host — cannot list sessions." })
    return
  }
  let rootOverride: string | undefined
  while (true) {
    const data = await loadExplorerData(api, directory, rootOverride)
    if (!data) {
      await showInfo(api, {
        title: "Subagent Explorer",
        message: "Could not load the session list from the host.\n\nThe host client does not expose session.list for this directory.",
      })
      return
    }
    const rootID = currentSessionID(rootOverride ?? api.currentSessionID?.(), data.sessions)
    if (!rootID) {
      await showInfo(api, { title: "Subagent Explorer", message: "No sessions found in this directory." })
      return
    }
    const tree = buildSessionTree(data.sessions, rootID)
    const rows = explorerRows(tree, data)
    const idleCount = rows.filter((row) => !row.running).length
    const rootSession = data.sessions.find((session) => session.id === rootID)
    const action = await showTreeOnce(api, {
      rows,
      rootTitle: rootSession?.title ?? rootID,
      rootID,
      activeKnown: data.activeKnown,
      idleCount,
    })
    if (!action || action.type === "exit") return
    if (action.type === "refresh") continue
    if (action.type === "size") {
      await showSizeSlider(api)
      continue
    }
    if (action.type === "switch-root") {
      const next = await showRootPicker(api, data.sessions, rootID)
      if (next) rootOverride = next
      continue
    }
    if (action.type === "delete") {
      await deleteOne(api, action.row)
      continue
    }
    if (action.type === "details") {
      await showDetails(api, action.row, data)
      continue
    }
    if (action.type === "cleanup") {
      await runCleanup(api, cleanupTargets(tree, data.activeIDs), rootSession?.title ?? rootID, directory, rootID)
      continue
    }
  }
}
