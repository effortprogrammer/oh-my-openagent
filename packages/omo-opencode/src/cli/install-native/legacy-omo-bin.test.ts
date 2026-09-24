/// <reference types="bun-types" />

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  firstOmoBinOnPath,
  legacyOmoBins,
  nativeOmoBin,
  resolveOmoBinEnvironment,
  scanOmoBins,
} from "./legacy-omo-bin"
import { createBinFixtureRoot, writeCodexLightRuntimeWrapper, writeGlobalPackageBin } from "./omo-bin-test-fixtures"

const roots: string[] = []

function root(label: string): string {
  const created = createBinFixtureRoot(label)
  roots.push(created)
  return created
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function environmentOf(pathDirectories: readonly string[], extraDirectories: readonly string[] = []) {
  return { pathDirectories, extraDirectories, isWindows: false }
}

describe("scanOmoBins", () => {
  test("#given an npm global omo symlinked into oh-my-openagent #when scanning #then the entry is legacy and names the owner", () => {
    // given
    const npm = writeGlobalPackageBin({
      root: root("npm-legacy"),
      packageName: "oh-my-openagent",
      version: "4.19.4",
      bins: ["omo", "oh-my-openagent", "lazycodex"],
    })

    // when
    const entries = scanOmoBins(environmentOf([npm.binDir]))

    // then
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("legacy")
    expect(entries[0]?.packageName).toBe("oh-my-openagent")
    expect(entries[0]?.packageVersion).toBe("4.19.4")
    expect(entries[0]?.binPath).toBe(join(npm.binDir, "omo"))
    expect(entries[0]?.onPath).toBe(true)
  })

  test("#given a bun global omo shim script pointing at omo-ai #when scanning #then the entry is native", () => {
    // given
    const bun = writeGlobalPackageBin({
      root: root("bun-native"),
      packageName: "omo-ai",
      version: "5.0.0-0.beta.89",
      link: "script",
    })

    // when
    const entries = scanOmoBins(environmentOf([bun.binDir]))

    // then
    expect(entries[0]?.kind).toBe("native")
    expect(entries[0]?.packageName).toBe("omo-ai")
    expect(nativeOmoBin(entries)?.binPath).toBe(bun.binPath)
    expect(legacyOmoBins(entries)).toEqual([])
  })

  test("#given a legacy npm bin earlier on PATH than the native bun bin #when scanning #then the legacy one resolves first", () => {
    // given
    const npm = writeGlobalPackageBin({ root: root("npm-shadow"), packageName: "oh-my-openagent", version: "4.19.4" })
    const bun = writeGlobalPackageBin({ root: root("bun-shadowed"), packageName: "omo-ai", version: "5.0.0-0.beta.89" })

    // when
    const entries = scanOmoBins(environmentOf([npm.binDir, bun.binDir]))

    // then
    expect(firstOmoBinOnPath(entries)?.kind).toBe("legacy")
    expect(nativeOmoBin(entries)?.binPath).toBe(bun.binPath)
    expect(legacyOmoBins(entries).map((entry) => entry.binPath)).toEqual([npm.binPath])
  })

  test("#given an omo owned by an unrelated package #when scanning #then it is foreign and never offered for removal", () => {
    // given
    const other = writeGlobalPackageBin({ root: root("foreign"), packageName: "omo-tools", version: "1.2.3" })

    // when
    const entries = scanOmoBins(environmentOf([other.binDir]))

    // then
    expect(entries[0]?.kind).toBe("foreign")
    expect(entries[0]?.packageName).toBe("omo-tools")
    expect(legacyOmoBins(entries)).toEqual([])
  })

  test("#given the bun global bin dir is not on PATH #when scanning #then the entry is found and marked off-PATH", () => {
    // given
    const bun = writeGlobalPackageBin({ root: root("bun-offpath"), packageName: "omo-ai", version: "5.0.0-0.beta.89" })

    // when
    const entries = scanOmoBins(environmentOf([], [bun.binDir]))

    // then
    expect(entries[0]?.onPath).toBe(false)
    expect(firstOmoBinOnPath(entries)).toBeNull()
  })

  test("#given an omo linked straight out of a source checkout #when scanning #then it is foreign, not a package-owned bin", () => {
    // given a hand-made link whose nearest manifest is a checkout of this repo, not an install
    const created = root("checkout")
    const binDir = join(created, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(created, "package.json"), JSON.stringify({ name: "oh-my-opencode", version: "5.0.0-beta.89" }))
    writeFileSync(join(binDir, "omo"), "#!/bin/sh\nexec bun run ./src/cli/index.ts \"$@\"\n", { mode: 0o755 })

    // when
    const entries = scanOmoBins(environmentOf([binDir]))

    // then
    expect(entries[0]?.kind).toBe("foreign")
    expect(legacyOmoBins(entries)).toEqual([])
  })

  test("#given a real-sized package manifest #when scanning #then the owner is still read in full", () => {
    // given
    const npm = writeGlobalPackageBin({ root: root("big-manifest"), packageName: "oh-my-openagent", version: "4.19.4" })
    const manifestPath = join(npm.packageDir, "package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    manifest["description"] = "x".repeat(32_768)
    writeFileSync(manifestPath, JSON.stringify(manifest))

    // when
    const entries = scanOmoBins(environmentOf([npm.binDir]))

    // then
    expect(entries[0]?.kind).toBe("legacy")
    expect(entries[0]?.packageVersion).toBe("4.19.4")
  })

  test("#given a windows-style shim naming the package by relative path #when scanning #then the owner is still identified", () => {
    // given
    const created = root("win-shim")
    const binDir = join(created, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, "omo.cmd"),
      '@"%~dp0\\..\\lib\\node_modules\\oh-my-openagent\\bin\\oh-my-opencode.js" %*\r\n',
    )

    // when
    const entries = scanOmoBins({ pathDirectories: [binDir], extraDirectories: [], isWindows: true })

    // then
    expect(entries[0]?.kind).toBe("legacy")
    expect(entries[0]?.packageName).toBe("oh-my-openagent")
    expect(entries[0]?.packageVersion).toBeNull()
    expect(entries[0]?.shimPaths).toEqual([join(binDir, "omo.cmd")])
  })

  test("#given a directory repeated on PATH #when scanning #then it is reported once", () => {
    // given
    const npm = writeGlobalPackageBin({ root: root("dupe"), packageName: "oh-my-opencode", version: "4.19.4" })

    // when
    const entries = scanOmoBins(environmentOf([npm.binDir, npm.binDir], [npm.binDir]))

    // then
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("legacy")
  })
})

describe("resolveOmoBinEnvironment", () => {
  test("#given BUN_INSTALL set and its bin dir missing from PATH #when resolving #then it is probed as an extra directory", () => {
    // given
    const env = { PATH: "/usr/local/bin:/usr/bin", BUN_INSTALL: "/home/dev/.bun" }

    // when
    const environment = resolveOmoBinEnvironment({ env, platform: "darwin", homeDir: "/home/dev" })

    // then
    expect(environment.pathDirectories).toEqual(["/usr/local/bin", "/usr/bin"])
    expect(environment.extraDirectories).toEqual(["/home/dev/.bun/bin"])
    expect(environment.isWindows).toBe(false)
  })

  test("#given the bun bin dir already on PATH #when resolving #then it is not probed twice", () => {
    // given
    const env = { PATH: "/home/dev/.bun/bin:/usr/bin" }

    // when
    const environment = resolveOmoBinEnvironment({ env, platform: "linux", homeDir: "/home/dev" })

    // then
    expect(environment.extraDirectories).toEqual([])
  })

  test("#given windows #when resolving #then PATH is split on semicolons and the platform is flagged", () => {
    // given
    const env = { Path: "C:\\npm;C:\\Users\\dev\\.bun\\bin" }

    // when
    const environment = resolveOmoBinEnvironment({ env, platform: "win32", homeDir: "C:\\Users\\dev" })

    // then
    expect(environment.pathDirectories).toEqual(["C:\\npm", "C:\\Users\\dev\\.bun\\bin"])
    expect(environment.isWindows).toBe(true)
  })
})

describe("scanOmoBins with a Codex Light runtime wrapper", () => {
  test("#given the omo wrapper a pre-rename Codex Light install wrote into ~/.local/bin #when scanning #then it is legacy and names the Light version", () => {
    // given
    const light = writeCodexLightRuntimeWrapper({ root: root("light-wrapper"), version: "4.19.4" })

    // when
    const entries = scanOmoBins(environmentOf([light.binDir]))

    // then
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("legacy")
    expect(entries[0]?.packageName).toBe("lazycodex")
    expect(entries[0]?.packageVersion).toBe("4.19.4")
  })

  test("#given a hand-written omo script that only mentions the Light cache path #when scanning #then it stays foreign", () => {
    // given
    const lookalike = writeCodexLightRuntimeWrapper({ root: root("light-lookalike"), version: "4.19.4", marker: "my own script" })

    // when
    const entries = scanOmoBins(environmentOf([lookalike.binDir]))

    // then
    expect(entries[0]?.kind).toBe("foreign")
  })
})
