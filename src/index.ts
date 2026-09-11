/**
 * Subagent Explorer server plugin (v1).
 *
 * The explorer is a TUI-driven tool: the server side exists purely so a
 * single opencode.json registration loads the plugin (and self-wires the
 * matching tui.json entry - see selfwire.ts). No hooks are registered; the
 * plugin never intercepts runtime behavior.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { ensureTuiRegistration, isSubagentExplorerSpec } from "./selfwire.js"

export const plugin: Plugin = async (input) => {
  // File-scan only, wrapped in try/catch: never blocks or breaks startup.
  try {
    ensureTuiRegistration({ directory: input.directory, worktree: input.worktree, env: process.env })
  } catch {
    /* self-wiring is best-effort */
  }
  return {}
}

export const __testInternals = { ensureTuiRegistration, isSubagentExplorerSpec }
