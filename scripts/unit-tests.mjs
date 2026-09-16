import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { __testInternals } from "../dist/index.js"
import {
  buildSessionTree,
  cleanupTargets,
  collectSubtree,
  configAgentIDs,
  currentSessionID,
  deleteSession,
  fetchActiveSessionIDs,
  fetchSessions,
  fetchVariantAttribution,
  formatAge,
  hiddenAgentIDs,
  isHiddenAgent,
  loadAvSidecar,
  normalizeSession,
  parentCandidates,
  rowHidden,
} from "../dist/sessions.js"

let passed = 0
function ok(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

// --- normalizeSession ---

{
  const session = normalizeSession({ id: "s1", parentID: "p1", title: "T", agent: "explore", directory: "d", time: { created: "2026-09-11T00:00:00Z", updated: "2026-09-11T01:00:00Z" } })
  ok(session?.id === "s1" && session?.parentID === "p1" && session?.agent === "explore", "normalizeSession maps flat fields")
  ok(typeof session?.created === "number" && typeof session?.updated === "number", "normalizeSession parses ISO times")
  ok(normalizeSession(undefined) === undefined && normalizeSession({}) === undefined, "normalizeSession rejects shapeless rows")
  const objectAgent = normalizeSession({ id: "s2", agent: { id: "historian" } })
  ok(objectAgent?.agent === "historian", "normalizeSession unwraps object agents")
  const numericTime = normalizeSession({ id: "s3", time: { created: 1770000000000 } })
  ok(numericTime?.created === 1770000000000, "normalizeSession keeps numeric times")
}

// --- buildSessionTree / collectSubtree ---

{
  const sessions = [
    { id: "root", parentID: undefined },
    { id: "a2", parentID: "root", created: 200 },
    { id: "a1", parentID: "root", created: 100 },
    { id: "b1", parentID: "a1", created: 300 },
    { id: "c1", parentID: "b1", created: 400 },
    { id: "orphan", parentID: "other" },
  ]
  const tree = buildSessionTree(sessions, "root")
  ok(tree.length === 2 && tree[0].session.id === "a1" && tree[1].session.id === "a2", "tree children sorted by creation time")
  ok(tree[0].children[0]?.session.id === "b1" && tree[0].children[0]?.children[0]?.session.id === "c1", "tree nests recursively with depth")
  ok(tree[0].depth === 0 && tree[0].children[0].depth === 1, "depth increments")
  const flat = collectSubtree(tree)
  ok(flat.map((s) => s.id).join(",") === "a1,b1,c1,a2", "collectSubtree walks depth-first parents-first")

  // Deep chains (and malformed parent links) must not hang the builder.
  const deep = buildSessionTree([{ id: "r" }, { id: "a", parentID: "r" }, { id: "b", parentID: "a" }, { id: "c", parentID: "b" }], "r")
  ok(collectSubtree(deep).length === 3, "deep chains terminate")
}

// --- cleanupTargets ---

{
  const sessions = [
    { id: "root" },
    { id: "idle1", parentID: "root" },
    { id: "running1", parentID: "root" },
    { id: "idle2", parentID: "idle1" },
  ]
  const tree = buildSessionTree(sessions, "root")
  const plan = cleanupTargets(tree, new Set(["running1"]))
  ok(plan.deletable.length === 2 && plan.sparedActive.length === 1, "cleanup splits idle vs running")
  ok(plan.deletable[0].id === "idle2" && plan.deletable[1].id === "idle1", "cleanup order is leaf-first")
  const unknownPlan = cleanupTargets(tree, undefined)
  ok(unknownPlan.deletable.length === 3 && unknownPlan.sparedActive.length === 0, "unknown active set treats all as deletable (caller gates on activeKnown)")
}

// --- currentSessionID / parentCandidates ---

{
  const sessions = [
    { id: "s1", updated: 100 },
    { id: "s2", updated: 300 },
    { id: "s3", created: 500 },
  ]
  ok(currentSessionID("explicit", sessions) === "explicit", "explicit session wins")
  ok(currentSessionID(undefined, sessions) === "s3", "newest updated/created session is the fallback")
  const candidates = parentCandidates([{ id: "s1" }, { id: "child", parentID: "s1" }, { id: "s2" }])
  ok(candidates.length === 1 && candidates[0].id === "s1", "parentCandidates lists sessions that have children")
}

// --- hidden classification ---

{
  const config = { agent: { explore: {}, historian: { hidden: true }, plan: {} } }
  const hidden = hiddenAgentIDs(config)
  const known = configAgentIDs(config)
  ok(hidden.has("historian") && !hidden.has("explore"), "hiddenAgentIDs reads the hidden flag")
  ok(isHiddenAgent("historian", hidden, known), "config-flagged hidden agent is hidden")
  ok(isHiddenAgent("runtime-agent", hidden, known), "runtime-registered unknown agent is hidden")
  ok(!isHiddenAgent("explore", hidden, known), "config agent is not hidden")
  ok(!isHiddenAgent("plan", hidden, known), "builtin agent is not hidden")
  ok(!isHiddenAgent("av:explore-light", hidden, known), "agent-variants clone is not hidden")
  ok(!isHiddenAgent(undefined, hidden, known), "missing agent is not hidden")
}

// --- formatAge ---

{
  const now = Date.now()
  ok(formatAge(undefined) === "—" && formatAge(now) === "just now" && formatAge(now - 5 * 60_000) === "5m ago" && formatAge(now - 3 * 3_600_000) === "3h ago" && formatAge(now - -1) === "just now", "formatAge buckets")
}

// --- client seams: fetchSessions / fetchActiveSessionIDs / deleteSession ---

class FakeSessionNamespace {
  constructor(mode) {
    this.mode = mode
    this.calls = []
  }
  list(input) {
    this.calls.push(input)
    if (this.mode === "flat-envelope") return Promise.resolve({ data: [{ id: "s1", parentID: "r" }] })
    if (this.mode === "query") return Promise.resolve([{ id: "s1" }])
    if (this.mode === "detached-throw") {
      // Simulates receiver-dependent behavior: works attached, throws detached.
      if (!this) throw new TypeError("detached")
      return Promise.resolve([])
    }
    return Promise.resolve(undefined)
  }
  active() {
    if (!this) throw new TypeError("detached")
    return Promise.resolve({ data: { running1: {}, running2: true } })
  }
  status() {
    return Promise.resolve({ data: { s1: { status: "busy" }, s2: { status: "idle" }, s3: { status: "retry" } } })
  }
  delete(input) {
    this.calls.push(input)
    if (!this) throw new TypeError("detached")
    return Promise.resolve(true)
  }
}

{
  const flat = await fetchSessions({ session: new FakeSessionNamespace("flat-envelope") }, "dir")
  ok(flat?.length === 1 && flat[0].parentID === "r", "fetchSessions unwraps {data} envelopes")
  const queried = await fetchSessions({ session: new FakeSessionNamespace("query") }, "dir")
  ok(queried?.length === 1, "fetchSessions falls back to the {query} param shape")
  ok(await fetchSessions({ session: {} }, "dir") === undefined, "fetchSessions fails soft without list")

  const active = await fetchActiveSessionIDs({ session: new FakeSessionNamespace("flat-envelope") })
  ok(active?.has("running1") && active?.has("running2") && active?.size === 2, "fetchActiveSessionIDs reads the active map")

  const viaStatus = await fetchActiveSessionIDs({ session: { status: FakeSessionNamespace.prototype.status } })
  ok(viaStatus?.has("s1") && viaStatus?.has("s3") && !viaStatus?.has("s2"), "status fallback marks busy/retry as running")

  ok(await fetchActiveSessionIDs({ session: {} }) === undefined, "no methods -> undefined")

  // Presence-based active map: falsy values still count as running (matches
  // the studio reload coordinator's proven probing).
  {
    const calls = []
    const fake = {
      session: {
        active: async function () {
          calls.push("active")
          if (this !== fake.session) throw new Error("detached")
          return { data: { ses_a: 0, ses_b: false, ses_c: { drains: 1 } } }
        },
      },
    }
    const ids = await fetchActiveSessionIDs(fake)
    ok(ids?.has("ses_a") && ids?.has("ses_b") && ids?.has("ses_c") && ids?.size === 3, "active map membership means running, regardless of value truthiness")
  }

  // Status fallback reads `.type` (runtime shape), treats undefined as running.
  {
    const fake = {
      session: {
        status: async function () {
          if (this !== fake.session) throw new Error("detached")
          return { data: { ses_a: { type: "busy" }, ses_b: { type: "idle" }, ses_c: { type: "retry" }, ses_d: { type: undefined } } }
        },
      },
    }
    const ids = await fetchActiveSessionIDs(fake)
    ok(ids?.has("ses_a") && ids?.has("ses_c") && ids?.has("ses_d") && !ids?.has("ses_b"), "status fallback: busy/retry/undefined = running, idle = not")
  }

  const deleter = new FakeSessionNamespace("flat-envelope")
  ok((await deleteSession({ session: deleter }, "s1")) === true, "deleteSession uses session.delete attached")
  ok(deleter.calls[0]?.sessionID === "s1", "deleteSession sends the flat param shape first")
  ok((await deleteSession({ session: { remove: (input) => Promise.resolve(false) } }, "s9")) === true, "remove fallback counts a defined response as success")
  ok((await deleteSession({ session: {} }, "s9")) === false, "no delete methods -> false")

  // {error} envelope without data = the runtime's non-throwing failure shape:
  // must count as a failure, never as a successful delete.
  {
    const fake = {
      session: {
        delete: async function (input) {
          if (this !== fake.session) throw new Error("detached")
          const id = input.sessionID ?? input.path?.sessionID ?? input.id ?? input.path?.id
          return id === "s_bad" ? { error: "Session not found" } : { data: true }
        },
      },
    }
    ok((await deleteSession(fake, "s_bad")) === false, "deleteSession treats {error} envelopes as failures")
    ok((await deleteSession(fake, "s_ok")) === true, "deleteSession treats {data} envelopes as successes")
  }

  // The 100-row server cap fix: an explicit large limit is always sent.
  {
    const limitRecorder = new FakeSessionNamespace("flat-envelope")
    await fetchSessions({ session: limitRecorder }, "dir")
    ok(limitRecorder.calls[0]?.limit === 5000, `fetchSessions sends an explicit large limit (got ${JSON.stringify(limitRecorder.calls[0])})`)
  }
}

// --- selfwire ---

{
  const { ensureTuiRegistration, isSubagentExplorerSpec } = __testInternals
  ok(isSubagentExplorerSpec("@mirrowel/opencode-subagent-explorer") && isSubagentExplorerSpec("@mirrowel/opencode-subagent-explorer@0.1.0"), "npm specs match")
  ok(isSubagentExplorerSpec("file:///C:/Projects/OC%20Plugins/subagent-explorer"), "local folder spec matches")
  ok(!isSubagentExplorerSpec("@mirrowel/opencode-agent-variants") && !isSubagentExplorerSpec("file:///x/other"), "other plugins do not match")

  const run = (name, setup) => {
    const home = mkdtempSync(join(tmpdir(), `se-selfwire-${name}-`))
    const env = { ...process.env, USERPROFILE: home, HOME: home, OPENCODE_CONFIG_DIR: join(home, ".config", "opencode") }
    env.OPENCODE_CONFIG = undefined
    const dir = join(home, ".config", "opencode")
    mkdirSync(dir, { recursive: true })
    setup(dir, home)
    const result = ensureTuiRegistration({ env })
    const read = (relative) => {
      const file = join(home, relative)
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
    }
    const cleanup = () => rmSync(home, { recursive: true, force: true })
    return { result, read, cleanup }
  }

  const notRegistered = run("none", () => {})
  ok(notRegistered.result.status === "not-registered", "no registration -> not-registered")

  const wired = run("wired", (dir) => {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer"] }))
  })
  ok(wired.result.status === "wired", "server registration gets mirrored")
  ok(Array.isArray(wired.read(".config/opencode/tui.json")?.plugin) && wired.read(".config/opencode/tui.json").plugin[0] === "@mirrowel/opencode-subagent-explorer", "tui.json carries the mirrored entry")

  const project = run("project", (dir, home) => {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["other"] }))
    const projectDir = join(home, "work", "repo")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer"] }))
  })
  // (No worktree context: project layers are invisible -> not-registered.)
  ok(project.result.status === "not-registered", "project-only registration without worktree context stands down")

  const studio = run("studio", (dir) => {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-config-studio", "@mirrowel/opencode-subagent-explorer"] }))
  })
  ok(studio.result.status === "skipped-studio", "config studio presence skips selfwiring")

  const already = run("already", (dir) => {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer"] }))
    writeFileSync(join(dir, "tui.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer"] }))
  })
  ok(already.result.status === "already-wired", "matching tui entry -> already-wired")

  const corrected = run("corrected", (dir) => {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer@0.1.0"] }))
    writeFileSync(join(dir, "tui.json"), JSON.stringify({ plugin: ["@mirrowel/opencode-subagent-explorer", "@mirrowel/opencode-subagent-explorer"] }))
  })
  ok(corrected.result.status === "corrected", "duplicate tui entries are corrected")
  ok(corrected.read(".config/opencode/tui.json")?.plugin.length === 1, "correction deduped the tui entries")
  for (const fixture of [notRegistered, wired, project, studio, already, corrected]) fixture.cleanup()
}

// --- dual-target entry shapes ---

{
  const server = (await import("../dist/server.js")).default
  ok(server.id === "subagent-explorer" && typeof server.server === "function" && typeof server.setup === "function", "server default is dual-target {id, server, setup}")
  const tui = (await import("../dist/tui.js")).default
  ok(tui.id === "subagent-explorer" && typeof tui.tui === "function" && typeof tui.setup === "function", "tui default is dual-target {id, tui, setup}")
}

// --- AV awareness: sidecar loading ---

{
  const empty = loadAvSidecar(join(tmpdir(), "definitely-missing-dir-xyz"))
  ok(empty.parents.size === 0, "missing sidecar -> empty parents (fail-soft)")

  const home = mkdtempSync(join(tmpdir(), "se-av-"))
  writeFileSync(
    join(home, "agent-variants.jsonc"),
    `// agent-variants sidecar
{
  "agents": {
    "explore": { "parent": {}, "disable_base": true, "variants": { "explore-light": {} } },
    "general": { "parent": {}, "disable_base": true, "disable": true, "variants": {} },
    "plan": { "parent": {}, "variants": {} },
  },
}`,
    "utf8",
  )
  const sidecar = loadAvSidecar(home)
  ok(sidecar.parents.get("explore")?.disableBase === true, "sidecar: disable_base parsed")
  ok(sidecar.parents.get("general")?.disableBase === false, "sidecar: full disable beats disable_base")
  ok(sidecar.parents.get("plan")?.disableBase === false, "sidecar: plain parent not base-disabled")
  ok(sidecar.parents.size === 3, "sidecar: all parents parsed (comments tolerated)")
  rmSync(home, { recursive: true, force: true })
}

// --- AV awareness: variant attribution from task-part metadata ---

{
  const parts = [
    {
      parts: [
        { type: "tool", tool: "task", state: { metadata: { sessionId: "ses_light", agentVariants: { alias: "explore-light", routedAgent: "explore" } } } },
        { type: "tool", tool: "task", state: { metadata: { sessionId: "ses_plain", agentVariants: { alias: "plan-basic", routedAgent: "plan" } } } },
      ],
    },
    { parts: [{ type: "text", text: "not a task part" }] },
  ]
  const client = {
    session: {
      messages: async function (args) {
        if (this !== client.session) throw new Error("detached")
        ok(args.sessionID === "ses_parent" || args.path?.id === "ses_parent", "attribution fetch targets the root session")
        return { data: parts }
      },
    },
  }
  const map = await fetchVariantAttribution(client, "ses_parent", "C:/x", new Set(["explore", "plan"]))
  ok(map.get("ses_light")?.alias === "explore-light" && map.get("ses_light")?.parent === "explore", "attribution: alias + parent extracted")
  ok(map.get("ses_plain")?.alias === "plan-basic", "attribution: second variant captured")
  const none = await fetchVariantAttribution(client, "ses_parent", "C:/x", new Set())
  ok(none.size === 0, "attribution: skipped entirely without AV parents")

  // Attribution pages backward through the parent's history via the
  // `before` message cursor, so large trees attribute old children too.
  {
    const queries = []
    const pageOf = (index) => Array.from({ length: 100 }, (_, i) => ({
      id: `msg_${index}_${i}`,
      info: { id: `msg_${index}_${i}` },
      parts: [{ type: "tool", tool: "task", state: { metadata: { sessionId: `ses_child_${index}_${i}`, agentVariants: { alias: "explore-light", routedAgent: "explore" } } } }],
    }))
    const paged = {
      session: {
        messages: async function (args) {
          if (this !== paged.session) throw new Error("detached")
          queries.push(args)
          if (args.before === undefined) return { data: pageOf(0) }
          if (args.before === "msg_0_99") return { data: [...pageOf(1).slice(0, 40), { id: "msg_tail", info: { id: "msg_tail" }, parts: [] }] }
          return { data: [] }
        },
      },
    }
    const deep = await fetchVariantAttribution(paged, "ses_parent", "C:/x", new Set(["explore"]))
    ok(deep.get("ses_child_1_0")?.alias === "explore-light", "attribution: second page children attributed via the before cursor")
    ok(deep.size === 140, `attribution: pages combined (got ${deep.size})`)
    ok(queries[1]?.before === "msg_0_99" && queries[1]?.limit === 100, `attribution: cursor + limit carried (got ${JSON.stringify(queries[1])})`)
  }
}

// --- badge gating: AV-parent children never hidden-badged ---

{
  const avParents = new Map([
    ["explore", { disableBase: true }],
    ["general", { disableBase: false }],
  ])
  const hidden = new Set(["explore", "general", "historian"])
  const configAgents = new Set(["explore", "general", "build", "plan", "historian"])
  ok(rowHidden({ alias: "explore-light" }, "explore", avParents, hidden, configAgents) === false, "rowHidden: attributed variant child never badged")
  ok(rowHidden(undefined, "explore", avParents, hidden, configAgents) === false, "rowHidden: AV-parent child never badged, attribution or not")
  ok(rowHidden(undefined, "general", avParents, hidden, configAgents) === false, "rowHidden: config-hidden AV parent (unified hiding) never badged")
  ok(rowHidden(undefined, "historian", avParents, hidden, configAgents) === true, "rowHidden: genuinely hidden non-AV agent stays badged")
  ok(rowHidden(undefined, "some-plugin-agent", avParents, hidden, configAgents) === true, "rowHidden: runtime-registered agents stay badged")
  ok(rowHidden(undefined, "build", avParents, hidden, configAgents) === false, "rowHidden: visible config agents never badged")
}

console.log(`unit tests passed (${passed} checks)`)
