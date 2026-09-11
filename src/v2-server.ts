/**
 * OpenCode v2 server setup for subagent-explorer.
 *
 * Dormant by design: the explorer is TUI-driven and needs no server-side
 * hooks. v2 auto-discovers the ./tui export from server-declared plugins,
 * so this setup only exists to make the plugin loadable from the v2
 * `plugins` config (and to keep the dual-target entry shape uniform).
 */

import type { V2PluginContext, V2ServerSetup } from "./v2-types.js"

export function createV2ServerSetup(): V2ServerSetup {
  return async (_context: V2PluginContext) => {
    // Intentionally empty: no transforms, no hooks, no registrations.
    return () => undefined
  }
}
