import { pathToFileURL } from "node:url"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const root = fileURLToPath(new URL("..", import.meta.url))

function fakeHost() {
  const state = {
    capturedLayers: [],
    toasts: [],
    dialogEntries: [],
    config: { agent: {} },
  }
  const api = {
    __state: state,
    route: { current: { name: "session", params: { sessionID: "ses_root" } } },
    state: { config: state.config, provider: [], path: { config: "C:/x", directory: "C:/x", worktree: "C:/x" } },
    theme: { current: { text: "#eee", textMuted: "#999", background: "#111", backgroundPanel: "#1b1b1b", primary: "#2f6fdb", secondary: "#789", accent: "#4db6ac", success: "#4c4", warning: "#fb3", error: "#f55", info: "#3bf" } },
    kv: { get: (_k, fallback) => fallback, set: () => undefined, ready: true },
    lifecycle: { onDispose: () => undefined },
    mode: { push: () => () => undefined },
    renderer: {},
    client: {
      session: {
        list: async () => ({ data: [{ id: "ses_root", title: "Root" }, { id: "ses_child", parentID: "ses_root", title: "Child", agent: "explore", time: { created: 1, updated: 2 } }] }),
        active: async () => ({ data: {} }),
        delete: async (input) => true,
      },
    },
    ui: {
      toast: (input) => state.toasts.push(input),
      dialog: {
        replace: (renderer, onClose) => {
          // Real hosts render the thunk; mounting registers the dialog's
          // keymap layer, which the test drives.
          let content
          try {
            content = renderer()
          } catch {
            content = undefined
          }
          state.dialogEntries.push({ content, onClose })
        },
        clear: () => undefined,
        setSize: () => undefined,
      },
      DialogSelect: () => undefined,
      DialogPrompt: () => undefined,
      DialogConfirm: () => undefined,
      DialogAlert: () => undefined,
    },
    keymap: {
      registerLayer: (layer) => {
        state.capturedLayers.push(layer)
        return () => undefined
      },
    },
  }
  return api
}

// 1) The compiled TUI entry registers its palette command on activation.
{
  const mod = await import(`${pathToFileURL(path.join(root, "dist", "tui.js")).href}?${Date.now()}`)
  assert.equal(mod.default.id, "subagent-explorer")
  assert.equal(typeof mod.default.tui, "function")
  const api = fakeHost()
  await mod.default.tui(api, undefined, { id: "subagent-explorer" })
  const layer = api.__state.capturedLayers[0]
  assert.ok(layer, "tui entry registered a keymap layer")
  const command = layer.commands.find((entry) => entry.name === "subagent-explorer.open")
  assert.ok(command, "palette command registered")
  assert.equal(command.title, "Subagent Explorer: Open")
  assert.equal(command.slashName, "subagent-explorer")
  assert.equal(command.category, "Subagent Explorer", "palette category stamped")
}

// 2) Running the command with a working fake host completes without throwing
//    and renders the tree for the current session's children. (The dialog
//    component body needs a live renderer context to mount - covered by the
//    reactivity smoke - so this case ends the flow through the dialog's
//    onClose, exactly like pressing esc in a real host.)
{
  const mod = await import(`${pathToFileURL(path.join(root, "dist", "tui.js")).href}?${Date.now() + 1}`)
  const api = fakeHost()
  await mod.default.tui(api, undefined, { id: "subagent-explorer" })
  const layer = api.__state.capturedLayers[0]
  const command = layer.commands.find((entry) => entry.name === "subagent-explorer.open")
  const finished = command.run()
  // Let the async flow load data and open the tree dialog.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(api.__state.dialogEntries.length > 0, "explorer opened a dialog")
  const entry = api.__state.dialogEntries[api.__state.dialogEntries.length - 1]
  const treeLayer = api.__state.capturedLayers[api.__state.capturedLayers.length - 1]
  const exit = treeLayer !== layer && treeLayer?.commands?.find((candidate) => candidate.name.endsWith(".back"))
  if (exit) exit.run()
  else entry.onClose?.()
  await finished
}

// 3) The command is graceful with a dead client (no session API at all).
{
  const mod = await import(`${pathToFileURL(path.join(root, "dist", "tui.js")).href}?${Date.now() + 2}`)
  const api = fakeHost()
  api.client = {}
  await mod.default.tui(api, undefined, { id: "subagent-explorer" })
  const command = api.__state.capturedLayers[0].commands.find((entry) => entry.name === "subagent-explorer.open")
  const finished = command.run()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(api.__state.dialogEntries.length > 0, "dead client still informs via a dialog")
  api.__state.dialogEntries[api.__state.dialogEntries.length - 1].onClose?.()
  await finished
}

console.log("TUI startup smoke passed")
