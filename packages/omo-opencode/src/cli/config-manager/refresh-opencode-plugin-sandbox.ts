import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  getOpenCodeCacheDir,
  getPluginSandboxDir,
  log,
  parseJsonc,
  removePluginSandbox,
} from "../../shared"
import { getConfigDir } from "./config-context"

/**
 * Clears OpenCode's plugin sandbox for the spec(s) the installer just wrote.
 *
 * OpenCode serves the plugin from `<cache>/packages/<spec>/` and its
 * `Npm.add()` never re-resolves the tag while that sandbox exists, so a user
 * who re-runs the installer to upgrade would keep loading the version cached
 * there. The installer runs outside OpenCode, which makes this the one moment
 * the directory can be removed with no live session reading from it; the next
 * OpenCode start reinstalls the spec at its current version.
 *
 * Only the specs the config actually loads are touched, so an unrelated
 * channel a user keeps around (`@beta` next to `@latest`) is left alone.
 */

export interface RefreshOpenCodePluginSandboxesOptions {
  readonly configDir?: string
  readonly cacheDir?: string
}

export interface RefreshOpenCodePluginSandboxesResult {
  readonly removed: readonly string[]
}

type ConfigShape = {
  readonly plugin?: readonly unknown[]
}

function readPluginEntries(configDir: string): readonly string[] {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const configPath = join(configDir, name)
    if (!existsSync(configPath)) continue
    try {
      const parsed = parseJsonc<ConfigShape>(readFileSync(configPath, "utf-8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      return (parsed.plugin ?? []).filter((entry): entry is string => typeof entry === "string")
    } catch (error) {
      if (!(error instanceof Error)) throw error
      log(`[install] Could not read plugin entries from ${configPath}: ${error.message}`)
    }
  }
  return []
}

export function refreshOpenCodePluginSandboxes(
  options: RefreshOpenCodePluginSandboxesOptions = {},
): RefreshOpenCodePluginSandboxesResult {
  // The same config dir the installer just wrote to, so a profile or a
  // non-default binary layout refreshes the spec it actually loads.
  const configDir = options.configDir ?? getConfigDir()
  const cacheDir = options.cacheDir ?? getOpenCodeCacheDir()

  const removed: string[] = []
  for (const entry of readPluginEntries(configDir)) {
    const sandboxDir = getPluginSandboxDir(cacheDir, entry)
    if (!sandboxDir) continue
    try {
      if (!removePluginSandbox(sandboxDir, cacheDir)) continue
      removed.push(sandboxDir)
      log(`[install] Removed stale OpenCode plugin sandbox: ${sandboxDir}`)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      log(`[install] Failed to remove OpenCode plugin sandbox ${sandboxDir}: ${error.message}`)
    }
  }

  return { removed }
}
