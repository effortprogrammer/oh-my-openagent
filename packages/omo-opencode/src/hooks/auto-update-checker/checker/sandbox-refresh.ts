import { log } from "../../../shared/logger"
import { getOpenCodeCacheDir } from "../../../shared/data-path"
import { isPluginSandboxDir, removePluginSandbox } from "../../../shared/opencode-plugin-sandbox"

/**
 * Makes "restart to apply" true for a plugin running from an OpenCode-managed
 * sandbox.
 *
 * OpenCode's `Npm.add()` serves the plugin from `<cache>/packages/<spec>/` and
 * skips resolution entirely while that sandbox exists, so a restart alone
 * reloads the same old version forever. Removing the sandbox is the only way
 * to make the next start install the channel's current version.
 *
 * Removal waits for process exit because the live session still reads from
 * that directory — bundled skills, the `./tui` export, provisioned binaries
 * and any lazily imported chunk all resolve inside it. Once `exit` fires the
 * event loop is drained and nothing can import from it again. A process that
 * dies from a signal never emits `exit`; that costs nothing, because the next
 * start runs the same check and schedules the removal again (and the
 * installer clears the sandbox outright).
 */

export interface SandboxRefreshDeps {
  /** Registers a callback for process exit. Defaults to `process.once("exit")`. */
  onExit?: (callback: () => void) => void
  /** The OpenCode cache root that must contain the sandbox. */
  cacheDir?: string
}

const scheduledSandboxDirs = new Set<string>()

export function scheduleOpenCodeSandboxRefreshOnExit(sandboxDir: string, deps: SandboxRefreshDeps = {}): void {
  const cacheDir = deps.cacheDir ?? getOpenCodeCacheDir()
  if (!isPluginSandboxDir(sandboxDir, cacheDir)) {
    log(`[auto-update-checker] Not an OpenCode plugin sandbox, leaving it alone: ${sandboxDir}`)
    return
  }

  if (scheduledSandboxDirs.has(sandboxDir)) return
  scheduledSandboxDirs.add(sandboxDir)

  const onExit = deps.onExit ?? ((callback: () => void) => process.once("exit", callback))
  onExit(() => {
    try {
      const removed = removePluginSandbox(sandboxDir, cacheDir)
      log(
        removed
          ? `[auto-update-checker] Removed stale OpenCode plugin sandbox on exit: ${sandboxDir}`
          : `[auto-update-checker] OpenCode plugin sandbox already gone: ${sandboxDir}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[auto-update-checker] Failed to remove OpenCode plugin sandbox ${sandboxDir}: ${message}`)
    }
  })
  log(`[auto-update-checker] Scheduled OpenCode plugin sandbox refresh on exit: ${sandboxDir}`)
}
