/**
 * Core subagent-session data layer. Pure tree/classification logic plus
 * fail-soft client seams. Every client call is attached to its namespace
 * object (v2-gen class methods throw when detached), feature-detected,
 * timeout-bounded, and envelope-unwrapping ({data} vs raw) so one code path
 * serves the v1 and v2 hosts and the studio embed alike.
 */

export type SessionLite = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  directory?: string
  created?: number
  updated?: number
}

export type SessionTreeNode = {
  session: SessionLite
  depth: number
  children: SessionTreeNode[]
}

export type CleanupPlan = {
  /** Idle sessions, ordered leaf-first so children die before parents. */
  deletable: SessionLite[]
  /** Sessions spared because they are running right now. */
  sparedActive: SessionLite[]
}

const CALL_TIMEOUT_MS = 5000

/** OpenCode's built-in agent ids (v1): anything else that is not in the
 * user's config was registered at runtime (plugins) and is treated as
 * hidden/background for display purposes. */
export const BUILTIN_AGENTS = new Set(["build", "plan"])

export function withTimeout<T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS): Promise<T | undefined> {
  return Promise.race([Promise.resolve().then(fn).catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])
}

function unwrap<T>(value: T | { data?: T } | undefined): T | undefined {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) return (value as { data?: T }).data
  return value as T | undefined
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

export function normalizeSession(raw: unknown): SessionLite | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, any>
  const id = typeof record.id === "string" ? record.id : undefined
  if (!id) return undefined
  const agentRaw = record.agent
  const agent =
    typeof agentRaw === "string"
      ? agentRaw
      : typeof agentRaw?.id === "string"
        ? agentRaw.id
        : typeof agentRaw?.agentID === "string"
          ? agentRaw.agentID
          : undefined
  const time = record.time && typeof record.time === "object" ? record.time : {}
  return {
    id,
    parentID: typeof record.parentID === "string" ? record.parentID : undefined,
    title: typeof record.title === "string" && record.title !== "" ? record.title : undefined,
    agent,
    directory: typeof record.directory === "string" ? record.directory : undefined,
    created: toMillis(time.created ?? record.time_created),
    updated: toMillis(time.updated ?? record.time_updated),
  }
}

/** Lists sessions for a directory. Tries the v2 client's flat params first,
 * then the v1 `{query}` shape; unwraps both envelope styles. Fail-soft. */
export async function fetchSessions(client: unknown, directory: string): Promise<SessionLite[] | undefined> {
  const namespace = (client as { session?: Record<string, any> } | undefined)?.session
  if (!namespace?.list) return undefined
  const calls: (() => Promise<unknown>)[] = [
    () => namespace.list({ directory }),
    () => namespace.list({ query: { directory } }),
  ]
  for (const call of calls) {
    const result = unwrap(await withTimeout(call))
    if (Array.isArray(result)) return result.map(normalizeSession).filter((s): s is SessionLite => !!s)
  }
  return undefined
}

/** Running session ids via `session.active()` with the `session.status()`
 * fallback (busy/retry = running). `undefined` when neither exists or both
 * fail — callers must treat that as "unknown", never "idle". */
export async function fetchActiveSessionIDs(client: unknown): Promise<Set<string> | undefined> {
  const namespace = (client as { session?: Record<string, any> } | undefined)?.session
  if (!namespace) return undefined
  if (typeof namespace.active === "function") {
    const active = unwrap(await withTimeout(() => namespace.active()))
    if (active && typeof active === "object") {
      const ids = new Set<string>()
      for (const [id, value] of Object.entries(active as Record<string, unknown>)) {
        if (value) ids.add(id)
      }
      return ids
    }
  }
  if (typeof namespace.status === "function") {
    const status = unwrap(await withTimeout(() => namespace.status()))
    if (status && typeof status === "object") {
      const ids = new Set<string>()
      for (const [id, value] of Object.entries(status as Record<string, any>)) {
        const state = value?.status ?? value
        if (state === "busy" || state === "retry") ids.add(id)
      }
      return ids
    }
  }
  return undefined
}

/** Builds the recursive subagent tree for `rootID`. Unknown-parent sessions
 * are ignored (not part of this session's tree). Guarded against cycles. */
export function buildSessionTree(sessions: SessionLite[], rootID: string): SessionTreeNode[] {
  const byParent = new Map<string, SessionLite[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = byParent.get(session.parentID) ?? []
    list.push(session)
    byParent.set(session.parentID, list)
  }
  const createdOf = (session: SessionLite) => session.created ?? 0
  const sortSiblings = (list: SessionLite[]) => [...list].sort((a, b) => createdOf(a) - createdOf(b))
  const visited = new Set<string>([rootID])
  const build = (list: SessionLite[], depth: number): SessionTreeNode[] =>
    sortSiblings(list).map((session) => {
      if (visited.has(session.id)) return { session, depth, children: [] }
      visited.add(session.id)
      const children = build(byParent.get(session.id) ?? [], depth + 1)
      return { session, depth, children }
    })
  return build(byParent.get(rootID) ?? [], 0)
}

/** Flattens a tree depth-first, parents before their children. */
export function collectSubtree(nodes: SessionTreeNode[]): SessionLite[] {
  const out: SessionLite[] = []
  const walk = (list: SessionTreeNode[]) => {
    for (const node of list) {
      out.push(node.session)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Splits a tree into deletable (idle) and spared (running) sessions.
 * Deletable order is leaf-first: children are removed before the parents
 * they hang off, so no cascade can leave dangling rows. */
export function cleanupTargets(nodes: SessionTreeNode[], activeIDs: Set<string> | undefined): CleanupPlan {
  const deletable: SessionLite[] = []
  const sparedActive: SessionLite[] = []
  const walk = (list: SessionTreeNode[]) => {
    for (const node of list) {
      walk(node.children)
      if (activeIDs?.has(node.session.id)) sparedActive.push(node.session)
      else deletable.push(node.session)
    }
  }
  walk(nodes)
  return { deletable, sparedActive }
}

/** The current session: the router's session id when the host provides one,
 * else the most recently updated session in the directory. */
export function currentSessionID(explicit: string | undefined, sessions: SessionLite[]): string | undefined {
  if (explicit) return explicit
  let newest: SessionLite | undefined
  for (const session of sessions) {
    const stamp = session.updated ?? session.created ?? 0
    const newestStamp = newest?.updated ?? newest?.created ?? 0
    if (!newest || stamp > newestStamp) newest = session
  }
  return newest?.id
}

/** Hidden/background classification: config agents flagged hidden, plus
 * runtime-registered agents OpenCode does not expose in the config. */
export function hiddenAgentIDs(config: unknown): Set<string> {
  const agents = (config as { agent?: Record<string, any> } | undefined)?.agent
  const hidden = new Set<string>()
  if (!agents || typeof agents !== "object") return hidden
  for (const [id, entry] of Object.entries(agents)) {
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).hidden === true) hidden.add(id)
  }
  return hidden
}

/** All agent ids the host knows about (config-declared). Anything absent
 * from this set and from the built-ins was registered at runtime. */
export function configAgentIDs(config: unknown): Set<string> {
  const agents = (config as { agent?: Record<string, any> } | undefined)?.agent
  if (!agents || typeof agents !== "object") return new Set<string>()
  return new Set(Object.keys(agents))
}

/** A session counts as hidden/background when its agent is flagged hidden
 * in the config, or the agent was registered at runtime (not config-known,
 * not built-in, not an agent-variants clone). */
export function isHiddenAgent(agent: string | undefined, hidden: Set<string>, configAgents: Set<string>): boolean {
  if (!agent) return false
  if (hidden.has(agent)) return true
  return !configAgents.has(agent) && !BUILTIN_AGENTS.has(agent) && !agent.startsWith("av:")
}

/** Deletes one session through whichever delete method the host client
 * exposes (`session.delete`, `session.remove`). Returns false when no
 * method exists or the call failed. */
export async function deleteSession(client: unknown, sessionID: string): Promise<boolean> {
  const namespace = (client as { session?: Record<string, any> } | undefined)?.session
  if (!namespace) return false
  const shapes: (() => Promise<unknown>)[] = []
  if (typeof namespace.delete === "function") {
    shapes.push(() => namespace.delete({ sessionID }), () => namespace.delete({ path: { sessionID } }), () => namespace.delete({ path: { id: sessionID } }), () => namespace.delete({ id: sessionID }))
  }
  if (typeof namespace.remove === "function") {
    shapes.push(() => namespace.remove({ sessionID }), () => namespace.remove({ path: { sessionID } }))
  }
  for (const call of shapes) {
    const result = await withTimeout(call)
    if (result !== undefined) return true
  }
  return false
}

export type SessionDetails = {
  messageCount: number
  model?: string
  firstPrompt?: string
}

/** Cheap detail read for the [i] view: last assistant model + first user
 * prompt, from a bounded tail of the session's messages. */
export async function fetchSessionDetails(client: unknown, sessionID: string): Promise<SessionDetails | undefined> {
  const namespace = (client as { session?: Record<string, any> } | undefined)?.session
  if (!namespace?.messages) return undefined
  const calls: (() => Promise<unknown>)[] = [
    () => namespace.messages({ sessionID, limit: 50 }),
    () => namespace.messages({ path: { id: sessionID }, query: { limit: 50 } }),
  ]
  for (const call of calls) {
    const result = unwrap(await withTimeout(call, 4000))
    const messages = Array.isArray(result) ? result : undefined
    if (!messages) continue
    let model: string | undefined
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = (messages[i] as any)?.info ?? messages[i]
      const modelRef = info?.model
      if (modelRef?.providerID && modelRef?.modelID) {
        model = `${modelRef.providerID}/${modelRef.modelID}${modelRef.variantID ? ` @${modelRef.variantID}` : ""}`
        break
      }
    }
    let firstPrompt: string | undefined
    for (const message of messages) {
      const info = (message as any)?.info ?? message
      if (info?.role !== "user") continue
      const text = firstTextOf((message as any).parts)
      if (text) {
        firstPrompt = text.length > 400 ? `${text.slice(0, 400)}…` : text
        break
      }
    }
    return { messageCount: messages.length, model, firstPrompt }
  }
  return undefined
}

function firstTextOf(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  for (const part of parts) {
    const text = (part as any)?.text ?? (part as any)?.part?.text
    if (typeof text === "string" && text.trim() !== "") return text.trim()
  }
  return undefined
}

export function formatAge(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return "—"
  const delta = Math.max(0, now - timestamp)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Groups sessions for the session picker: every session in the directory
 * that has children is a potential explorer root. */
export function parentCandidates(sessions: SessionLite[]): SessionLite[] {
  const parents = new Set<string>()
  for (const session of sessions) {
    if (session.parentID) parents.add(session.parentID)
  }
  return sessions
    .filter((session) => parents.has(session.id))
    .sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0))
}
