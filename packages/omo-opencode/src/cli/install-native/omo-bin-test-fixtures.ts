import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

export interface GlobalBinFixture {
  readonly root: string
  readonly binDir: string
  readonly binPath: string
  readonly packageDir: string
}

export interface GlobalBinFixtureOptions {
  readonly root: string
  readonly packageName: string
  readonly version: string
  readonly bins?: readonly string[]
  readonly link?: "symlink" | "script"
}

export function createBinFixtureRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `omo-bin-${label}-`))
}

/**
 * Lays out a global install the way npm and bun really do it: the package under
 * `lib/node_modules/<name>`, and one entry per bin in `bin/`, either a relative symlink
 * (npm and bun on POSIX) or a launcher script that names the package path (Windows shims and
 * omo-ai's own bun shim).
 */
export function writeGlobalPackageBin(options: GlobalBinFixtureOptions): GlobalBinFixture {
  const packageDir = join(options.root, "lib", "node_modules", ...options.packageName.split("/"))
  const entryPath = join(packageDir, "bin", "cli.js")
  const binDir = join(options.root, "bin")
  mkdirSync(join(packageDir, "bin"), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: options.packageName, version: options.version, bin: { omo: "bin/cli.js" } }),
  )
  writeFileSync(entryPath, "#!/usr/bin/env node\n")

  const bins = options.bins ?? ["omo"]
  for (const bin of bins) {
    const binPath = join(binDir, bin)
    if ((options.link ?? "symlink") === "symlink") symlinkSync(relative(binDir, entryPath), binPath)
    else writeFileSync(binPath, `#!/bin/sh\nexec bun "${entryPath}" "$@"\n`, { mode: 0o755 })
  }

  return { root: options.root, binDir, binPath: join(binDir, bins[0] ?? "omo"), packageDir }
}
