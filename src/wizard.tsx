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
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  buildSessionTree,
  cleanupTargets,
  configAgentIDs,
  currentSessionID,
  deleteSession,
  fetchActiveSessionIDs,
  fetchSessionDetails,
  fetchSessions,
  formatAge,
  hiddenAgentIDs,
  isHiddenAgent,
  parentCandidates,
  type CleanupPlan,
  type SessionLite,
  type SessionTreeNode,
} from "./sessions.js"

export type ExplorerRow = {
  session: SessionLite
  depth: number
  running: boolean
  hidden: boolean
}

export type ExplorerData = {
  sessions: SessionLite[]
  activeIDs: Set<string> | undefined
  activeKnown: boolean
  hidden: Set<string>
  configAgents: Set<string>
}

export type TreeAction =
  | { type: "delete"; row: ExplorerRow }
  | { type: "details"; row: ExplorerRow }
  | { type: "cleanup" }
  | { type: "refresh" }
  | { type: "switch-root" }
  | { type: "exit" }

export async function loadExplorerData(api: TuiPluginApi, directory: string): Promise<ExplorerData | undefined> {
  const sessions = await fetchSessions(api.client, directory)
  if (!sessions) return undefined
  const activeIDs = await fetchActiveSessionIDs(api.client)
  return {
    sessions,
    activeIDs,
    activeKnown: activeIDs !== undefined,
    hidden: hiddenAgentIDs(api.state.config),
    configAgents: configAgentIDs(api.state.config),
  }
}

export function explorerRows(tree: SessionTreeNode[], data: ExplorerData): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({
        session: node.session,
        depth,
        running: data.activeIDs?.has(node.session.id) ?? false,
        hidden: isHiddenAgent(node.session.agent, data.hidden, data.configAgents),
      })
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return rows
}

function themeOf(api: TuiPluginApi) {
  return api.theme.current
}

function cappedHeight(count: number, max: number, min = 1): number {
  return Math.max(min, Math.min(count, max))
}

function maxListRows(terminalHeight: number, minRows = 6): number {
  // 75% backdrop budget minus ~8 rows of chrome (header, hints, footer).
  const budget = Math.floor((terminalHeight * 3) / 4) - 8
  return Math.max(minRows, Math.min(24, budget))
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
  const popMode = props.api.mode.push("subagent-explorer.dialog")
  const [selected, setSelected] = createSignal(0)
  const current = createMemo(() => props.rows[selected()])
  let scroll: ScrollBoxRenderable | undefined
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
      <scrollbox maxHeight={cappedHeight(props.rows.length, maxListRows(dimensions().height), 3)} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
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
                    <text fg={titleFg()}>{row.running ? "▶" : "·"}</text>
                    <text width={18} flexShrink={0} fg={active() ? theme().background : theme().textMuted} wrapMode="none" overflow="hidden"><b>{truncate(row.session.agent ?? "agent", 18)}</b></text>
                    <Show when={row.hidden}>
                      <text fg={badgeFg()}>{"[hidden]"}</text>
                    </Show>
                    <text flexGrow={1} fg={titleFg()} wrapMode="none" overflow="hidden">{truncate(rowTitle(row), 60)}</text>
                    <text width={9} flexShrink={0} fg={active() ? theme().background : theme().textMuted}>{formatAge(row.session.updated ?? row.session.created)}</text>
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
  const maxHeight = cappedHeight(lines.length, Math.floor((dimensions().height * 3) / 4) - 8, 3)
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
  const summary = `${label}\nagent: ${row.session.agent ?? "unknown"}\nlast activity: ${formatAge(row.session.updated ?? row.session.created)}\n\nDeleting a session permanently removes it, its messages, and its history. The parent session keeps the task result text; only the jump target is lost.`
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

async function runCleanup(api: TuiPluginApi, plan: CleanupPlan, rootTitle: string): Promise<number> {
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
  for (const session of plan.deletable) {
    if (await deleteSession(api.client, session.id)) deleted += 1
  }
  const failed = plan.deletable.length - deleted
  api.ui.toast({
    variant: failed > 0 ? "warning" : "default",
    title: "Cleanup finished",
    message: failed > 0 ? `Deleted ${deleted}, failed ${failed}.` : `Deleted ${deleted} session(s).`,
  })
  return deleted
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

async function showDetails(api: TuiPluginApi, row: ExplorerRow): Promise<void> {
  const details = await fetchSessionDetails(api.client, row.session.id)
  const lines = [
    `title: ${rowTitle(row)}`,
    `agent: ${row.session.agent ?? "unknown"}${row.hidden ? " (hidden/background)" : ""}`,
    `session: ${row.session.id}`,
    `status: ${row.running ? "running" : "idle"}`,
    `created: ${formatAge(row.session.created)}`,
    `last activity: ${formatAge(row.session.updated ?? row.session.created)}`,
  ]
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

/** The explorer entry point: runs the tree browser loop until the user exits. */
export async function mainMenu(api: TuiPluginApi): Promise<void> {
  const directory = api.state.path?.directory ?? api.state.path?.worktree ?? ""
  if (!directory) {
    await showInfo(api, { title: "Subagent Explorer", message: "No project directory is available from the host — cannot list sessions." })
    return
  }
  let rootOverride: string | undefined
  while (true) {
    const data = await loadExplorerData(api, directory)
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
      await showDetails(api, action.row)
      continue
    }
    if (action.type === "cleanup") {
      await runCleanup(api, cleanupTargets(tree, data.activeIDs), rootSession?.title ?? rootID)
      continue
    }
  }
}
