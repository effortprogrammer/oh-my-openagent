import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"

export const NATIVE_OMO_PACKAGE = "omo-ai"
export const LEGACY_OMO_BIN_PACKAGES: readonly string[] = ["oh-my-openagent", "oh-my-opencode"]

const OMO_BIN_NAME = "omo"
// Windows filenames are case-insensitive, so one spelling per extension is enough.
const WINDOWS_BIN_SUFFIXES: readonly string[] = ["", ".cmd", ".ps1", ".exe"]
const OWNER_WALK_UP_LIMIT = 6
// Only the launcher shim is read for a path fragment, so it is capped. A package manifest is parsed
// as JSON and must be read whole: real manifests run well past any cap, and a truncated one parses
// as nothing, which used to make a legacy bin look unowned.
const SHIM_READ_LIMIT = 8192

export type OmoBinKind = "native" | "legacy" | "foreign"

export interface OmoBinEnvironment {
  readonly pathDirectories: readonly string[]
  readonly extraDirectories: readonly string[]
  readonly isWindows: boolean
}

export interface OmoBinEntry {
  readonly binPath: string
  readonly directory: string
  readonly onPath: boolean
  readonly kind: OmoBinKind
  readonly packageName: string | null
  readonly packageVersion: string | null
  /** Every file that carries this `omo` command, including the Windows `.cmd` / `.ps1` siblings. */
  readonly shimPaths: readonly string[]
}

interface OmoBinOwner {
  readonly name: string
  readonly version: string | null
}

export function resolveOmoBinEnvironment(input: {
  readonly env: Record<string, string | undefined>
  readonly platform: string
  readonly homeDir: string
}): OmoBinEnvironment {
  const isWindows = input.platform === "win32"
  const pathValue = input.env["PATH"] ?? input.env["Path"] ?? ""
  const pathDirectories = pathValue
    .split(isWindows ? ";" : delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
  const bunInstall = input.env["BUN_INSTALL"]
  const bunBinDir = bunInstall ? join(bunInstall, "bin") : join(input.homeDir, ".bun", "bin")
  const extraDirectories = pathDirectories.includes(bunBinDir) ? [] : [bunBinDir]
  return { pathDirectories, extraDirectories, isWindows }
}

export function scanOmoBins(environment: OmoBinEnvironment): readonly OmoBinEntry[] {
  const visited = new Set<string>()
  const entries: OmoBinEntry[] = []

  const visit = (directory: string, onPath: boolean): void => {
    if (directory === "" || visited.has(directory)) return
    visited.add(directory)
    const shimPaths = omoShimPathsIn(directory, environment.isWindows)
    const binPath = shimPaths[0]
    if (binPath === undefined) return
    const owner = resolveOwner(binPath)
    entries.push({
      binPath,
      directory,
      onPath,
      kind: classify(owner),
      packageName: owner?.name ?? null,
      packageVersion: owner?.version ?? null,
      shimPaths,
    })
  }

  for (const directory of environment.pathDirectories) visit(directory, true)
  for (const directory of environment.extraDirectories) visit(directory, false)
  return entries
}

export function legacyOmoBins(entries: readonly OmoBinEntry[]): readonly OmoBinEntry[] {
  return entries.filter((entry) => entry.kind === "legacy")
}

export function nativeOmoBin(entries: readonly OmoBinEntry[]): OmoBinEntry | null {
  return entries.find((entry) => entry.kind === "native") ?? null
}

export function firstOmoBinOnPath(entries: readonly OmoBinEntry[]): OmoBinEntry | null {
  return entries.find((entry) => entry.onPath) ?? null
}

function classify(owner: OmoBinOwner | null): OmoBinKind {
  if (owner === null) return "foreign"
  if (owner.name === NATIVE_OMO_PACKAGE) return "native"
  return LEGACY_OMO_BIN_PACKAGES.includes(owner.name) ? "legacy" : "foreign"
}

function omoShimPathsIn(directory: string, isWindows: boolean): readonly string[] {
  const suffixes = isWindows ? WINDOWS_BIN_SUFFIXES : [""]
  return suffixes.map((suffix) => join(directory, `${OMO_BIN_NAME}${suffix}`)).filter(pathExists)
}

// A dangling symlink still occupies the bin name, and that is exactly what npm refuses to overwrite,
// so presence is decided by lstat rather than by whether the target resolves.
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function resolveOwner(binPath: string): OmoBinOwner | null {
  // Ownership means an installed package. A bin linked straight out of a source checkout resolves to
  // no package at all, so it stays foreign and is never removed, however its checkout is named.
  const real = realPathOf(binPath)
  const fromLink = isInsideNodeModules(real) ? ownerOfFile(real) : null
  if (fromLink !== null) return fromLink

  const shim = readShimText(binPath)
  if (shim === null) return null
  // A relative shim path (every Windows `.cmd`) must not be walked: resolving it would climb out of
  // the current working directory and report whatever package.json happens to sit above it.
  const referenced = shim.match(/["']([^"'\n]*node_modules[\\/][^"'\n]*)["']/)?.[1]
  const fromReference =
    referenced === undefined || !isAbsolute(referenced) || !isInsideNodeModules(referenced)
      ? null
      : ownerOfFile(referenced)
  if (fromReference !== null) return fromReference

  const name = shim.match(/node_modules[\\/](@[^\\/"'\s]+[\\/])?([^\\/"'\s]+)/)
  const scope = name?.[1]?.replace(/[\\/]$/, "")
  const bare = name?.[2]
  if (bare === undefined) return null
  return { name: scope === undefined ? bare : `${scope}/${bare}`, version: null }
}

function isInsideNodeModules(path: string): boolean {
  return /(?:^|[\\/])node_modules[\\/]/.test(path)
}

function ownerOfFile(file: string): OmoBinOwner | null {
  let directory = dirname(file)
  for (let depth = 0; depth < OWNER_WALK_UP_LIMIT; depth += 1) {
    const manifest = readWholeFile(join(directory, "package.json"))
    if (manifest !== null) {
      const parsed = parseManifest(manifest)
      if (parsed !== null) return parsed
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

function parseManifest(manifest: string): OmoBinOwner | null {
  try {
    const parsed: unknown = JSON.parse(manifest)
    if (typeof parsed !== "object" || parsed === null) return null
    const record = parsed as { name?: unknown; version?: unknown }
    if (typeof record.name !== "string" || record.name === "") return null
    return { name: record.name, version: typeof record.version === "string" ? record.version : null }
  } catch {
    return null
  }
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readShimText(path: string): string | null {
  return readWholeFile(path)?.slice(0, SHIM_READ_LIMIT) ?? null
}

function readWholeFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
