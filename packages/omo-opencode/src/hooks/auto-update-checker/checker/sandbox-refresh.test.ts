import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getPluginSandboxRoot } from "../../../shared/opencode-plugin-sandbox"
import { scheduleOpenCodeSandboxRefreshOnExit } from "./sandbox-refresh"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-sandbox-exit-"))
  tempDirs.push(dir)
  return dir
}

function seedSandbox(cacheDir: string, spec: string): string {
  const dir = join(getPluginSandboxRoot(cacheDir), spec)
  mkdirSync(join(dir, "node_modules", "oh-my-openagent"), { recursive: true })
  writeFileSync(join(dir, "package-lock.json"), "{}")
  return dir
}

function exitRecorder(): { callbacks: (() => void)[]; onExit: (cb: () => void) => void } {
  const callbacks: (() => void)[] = []
  return { callbacks, onExit: (cb) => { callbacks.push(cb) } }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("scheduleOpenCodeSandboxRefreshOnExit", () => {
  test("#given a sandbox the live session still reads #when scheduling #then nothing is removed until the exit callback fires", () => {
    // given
    const cacheDir = tempDir()
    const sandboxDir = seedSandbox(cacheDir, "oh-my-openagent@beta")
    const { callbacks, onExit } = exitRecorder()

    // when
    scheduleOpenCodeSandboxRefreshOnExit(sandboxDir, { onExit, cacheDir })

    // then — the session keeps its files while it runs
    expect(existsSync(sandboxDir)).toBe(true)
    expect(callbacks).toHaveLength(1)

    // when the process exits
    callbacks[0]?.()

    // then the whole spec dir is gone, so Npm.add() reinstalls on next start
    expect(existsSync(sandboxDir)).toBe(false)
  })

  test("#given a workspace outside the OpenCode cache #when scheduling #then it registers nothing and deletes nothing", () => {
    // given — a plugin installed into a project or a global prefix
    const cacheDir = tempDir()
    const foreignWorkspace = join(tempDir(), "my-project")
    mkdirSync(foreignWorkspace, { recursive: true })
    const { callbacks, onExit } = exitRecorder()

    // when
    scheduleOpenCodeSandboxRefreshOnExit(foreignWorkspace, { onExit, cacheDir })

    // then
    expect(callbacks).toHaveLength(0)
    expect(existsSync(foreignWorkspace)).toBe(true)
  })

  test("#given the same sandbox scheduled twice #when registering #then only one exit callback is installed", () => {
    // given
    const cacheDir = tempDir()
    const sandboxDir = seedSandbox(cacheDir, "oh-my-openagent@latest")
    const { callbacks, onExit } = exitRecorder()

    // when
    scheduleOpenCodeSandboxRefreshOnExit(sandboxDir, { onExit, cacheDir })
    scheduleOpenCodeSandboxRefreshOnExit(sandboxDir, { onExit, cacheDir })

    // then
    expect(callbacks).toHaveLength(1)
  })

  test("#given the sandbox disappeared before exit #when the callback fires #then it does not throw", () => {
    // given
    const cacheDir = tempDir()
    const sandboxDir = seedSandbox(cacheDir, "oh-my-opencode@beta")
    const { callbacks, onExit } = exitRecorder()
    scheduleOpenCodeSandboxRefreshOnExit(sandboxDir, { onExit, cacheDir })
    rmSync(sandboxDir, { recursive: true, force: true })

    // when / then
    expect(() => callbacks[0]?.()).not.toThrow()
  })
})
