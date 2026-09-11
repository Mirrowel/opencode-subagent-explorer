/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid"
import { SubagentTreeDialog } from "../../dist/wizard.js"

function fakeHostApi() {
  let layer
  const theme = {
    text: "#e6e6e6",
    textMuted: "#9a9a9a",
    background: "#111111",
    backgroundPanel: "#1b1b1b",
    primary: "#2f6fdb",
    secondary: "#7a8ba8",
    accent: "#4db6ac",
    success: "#4caf50",
    warning: "#ffb300",
    error: "#ef5350",
    info: "#29b6f6",
  }
  return {
    api: {
      theme: { get current() { return theme } },
      kv: { get: (_key: string, fallback?: unknown) => fallback, set: () => undefined, ready: true },
      mode: { push: () => () => undefined },
      keymap: {
        registerLayer: (captured) => {
          layer = captured
          return () => undefined
        },
      },
      ui: {
        toast: () => undefined,
        dialog: { replace: () => undefined, clear: () => undefined, setSize: () => undefined },
        DialogSelect: () => undefined,
        DialogPrompt: () => undefined,
        DialogConfirm: () => undefined,
        DialogAlert: () => undefined,
      },
    },
    layer: () => layer,
  }
}

export async function verifyTreeDialogRenders() {
  const host = fakeHostApi()
  let done
  const finished = new Promise((resolve) => (done = resolve))
  const rows = [
    { session: { id: "s1", parentID: "root", title: "Review pair", agent: "explore-light", created: 1, updated: 2 }, depth: 0, running: true, hidden: false },
    { session: { id: "s2", parentID: "root", title: "Historian pass", agent: "historian", created: 3, updated: 4 }, depth: 0, running: false, hidden: true },
  ]
  const app = await testRender(
    () => (
      <SubagentTreeDialog
        api={host.api}
        rows={rows}
        rootTitle="Main session"
        rootID="root"
        activeKnown={true}
        idleCount={1}
        onDone={(value) => done(value)}
      />
    ),
    { width: 60, height: 16 },
  )
  try {
    await app.flush()
    const layer = host.layer()
    if (!layer) throw new Error("tree dialog did not register its keymap layer")
    const names = layer.commands.map((command) => command.name)
    for (const expected of ["up", "down", "select", "details", "cleanup", "refresh", "switch", "size", "back"]) {
      if (!names.some((name) => name.endsWith(`.${expected}`))) throw new Error(`keymap layer missing .${expected} command`)
    }
    // Drive a real selection move through the captured layer. Selection
    // changes only row COLORS, so compare full span captures, not chars.
    await app.flush()
    const frameBefore = app.captureCharFrame()
    const spansBefore = JSON.stringify(app.captureSpans())
    layer.commands.find((command) => command.name.endsWith(".down")).run({ event: { preventDefault: () => undefined, stopPropagation: () => undefined } })
    await app.flush()
    const frameAfter = app.captureCharFrame()
    const spansAfter = JSON.stringify(app.captureSpans())
    if (frameBefore.trim() === "" ) throw new Error("tree dialog rendered an empty frame")
    if (spansAfter === spansBefore) throw new Error("selection move did not repaint the dialog")
    if (!frameBefore.includes("Review pair") || !frameBefore.includes("Historian pass")) throw new Error("tree dialog does not render row titles")
    if (!frameBefore.includes("running")) throw new Error("tree dialog does not render the running count")
    // The [hidden] badge must stay on ONE line even at narrow widths.
    for (const line of frameBefore.split("\n")) {
      if (line.includes("[") && line.trimEnd().endsWith("[")) {
        throw new Error(`[hidden] badge wrapped mid-token: ${JSON.stringify(line)}`)
      }
    }
    if (!frameBefore.split("\n").some((line) => line.includes("[hidden]"))) throw new Error("[hidden] badge not rendered")
    void frameAfter
    // Selecting a row resolves the delete action.
    layer.commands.find((command) => command.name.endsWith(".select")).run()
    const action = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("select did not resolve")), 2000))])
    if (action?.type !== "delete" || action.row.session.id !== "s2") throw new Error(`select resolved with ${JSON.stringify(action)}`)
  } finally {
    app.renderer.destroy()
  }
}
