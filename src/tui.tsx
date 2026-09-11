/** @jsxImportSource @opentui/solid */

/**
 * Subagent Explorer TUI plugin entry.
 *
 * Thin wrapper: registers the palette/slash command and bootstraps the
 * explorer wizard library (wizard.tsx). Config Studio imports the wizard
 * library directly when the module is embedded.
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { TuiHostApi } from "./tui-host.js"
import { createV2TuiSetup } from "./v2-tui.js"
import { mainMenu } from "./wizard.js"
import { currentPaletteCategory, declarePaletteCategory, schedulePaletteReconcile } from "./palette-category.js"

function registerExplorerCommand(api: import("@opencode-ai/plugin/tui").TuiPluginApi, run: () => Promise<void>) {
  const command = {
    namespace: "palette",
    name: "subagent-explorer.open",
    title: "Subagent Explorer: Open",
    desc: "Explore and delete subagent sessions",
    category: "",
    slashName: "subagent-explorer",
    run,
  }
  command.category = declarePaletteCategory("Subagent Explorer", command)
  schedulePaletteReconcile()
  const apiWithKeymap = api as import("@opencode-ai/plugin/tui").TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: { commands: Array<typeof command>; bindings: unknown[] }) => () => void
    }
  }
  if (typeof apiWithKeymap.keymap?.registerLayer === "function") {
    return apiWithKeymap.keymap.registerLayer({ commands: [command], bindings: [] })
  }
  return api.command?.register(() => [
    {
      title: "Subagent Explorer: Open",
      value: "subagent-explorer.open",
      description: "Explore and delete subagent sessions",
      category: currentPaletteCategory(),
      slash: {
        name: "subagent-explorer",
      },
      onSelect: run,
    },
  ])
}

const tui: TuiPlugin = async (api) => {
  const unregister = registerExplorerCommand(api, async () => {
    // The v1 api satisfies TuiHostApi structurally; enrich it with the
    // router's current-session signal.
    const host = api as unknown as TuiHostApi & { route?: { current?: { name: string; params?: { sessionID?: string } } } }
    host.currentSessionID = () => (host.route?.current?.name === "session" ? host.route.current.params?.sessionID : undefined)
    await mainMenu(host)
  })

  api.lifecycle.onDispose(() => {
    unregister?.()
  })
}

/**
 * Dual-target TUI entry.
 *
 * - OpenCode v1 (strict loader) requires `default.tui` to be a function;
 *   excess keys are ignored.
 * - OpenCode v2 requires `default` to be `{ id, setup }`; its hand-written
 *   plugin check only inspects `id` + `setup`, so the legacy `tui` factory
 *   rides along harmlessly.
 */
export default { id: "subagent-explorer", tui, setup: createV2TuiSetup() }
