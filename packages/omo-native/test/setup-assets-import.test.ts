import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { teardownRoots } from "./teardown.test-support"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const roots: string[] = []

afterEach(() => teardownRoots(roots))

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

type Fixture = { home: string, agentDir: string, configHome: string, launcher: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omo-assets-e2e-"))
  roots.push(root)
  const app = join(root, "app")
  mkdirSync(join(root, "home"), { recursive: true })
  cpSync(join(SOURCE_ROOT, "bin"), join(app, "bin"), { recursive: true })
  write(join(app, "package.json"), JSON.stringify({ name: "omo-ai", version: "test", type: "module" }))
  return {
    home: join(root, "home"),
    agentDir: join(root, "senpi-agent"),
    configHome: join(root, "config"),
    launcher: join(app, "bin", "omo.js"),
  }
}

function opencode(item: Fixture, config: unknown, skills: string[] = []): void {
  const configDir = join(item.configHome, "opencode")
  write(join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
  for (const name of skills) {
    write(join(configDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: imported\n---\n\nbody\n`)
  }
}

function run(item: Fixture, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: item.home,
    USERPROFILE: item.home,
    SENPI_CODING_AGENT_DIR: item.agentDir,
    XDG_CONFIG_HOME: item.configHome,
    XDG_DATA_HOME: join(item.home, "unused-data"),
  }
  delete env.OMO_CODING_AGENT_DIR
  delete env.PI_CODING_AGENT_DIR
  delete env.OPENCODE_CONFIG_DIR
  const result = spawnSync(process.execPath, [item.launcher, ...args], { encoding: "utf8", env })
  if (result.error) throw result.error
  return result
}

function mcp(item: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(join(item.agentDir, "mcp.json"), "utf8"))
}

describe("omo setup opencode asset import", () => {
  describe("#given global opencode mcp servers and skills", () => {
    describe("#when setup is accepted", () => {
      test("#then they land in the engine's global mcp.json and global skill root", () => {
        const item = fixture()
        opencode(item, {
          mcp: {
            "local-tool": { type: "local", command: ["node", "server.js"], environment: { A: "b" } },
            "remote-tool": { type: "remote", url: "https://example.test/mcp" },
          },
        }, ["migrated-skill"])

        const result = run(item, ["setup", "--yes"])

        expect(result.status).toBe(0)
        expect(mcp(item)).toEqual({
          mcpServers: {
            "local-tool": { type: "stdio", command: "node", args: ["server.js"], env: { A: "b" } },
            "remote-tool": { type: "http", url: "https://example.test/mcp" },
          },
        })
        expect(existsSync(join(item.agentDir, "skills", "migrated-skill", "SKILL.md"))).toBe(true)
        expect(result.stdout).toContain("mcp-imported: 2")
        expect(result.stdout).toContain("skills-imported: 1")
      })
    })
  })

  describe("#given the engine already has a server and a skill of the same name", () => {
    describe("#when setup is accepted", () => {
      test("#then neither is overwritten and both are reported as skipped", () => {
        const item = fixture()
        const existingMcp = `${JSON.stringify({
          mcpServers: { keep: { type: "stdio", command: "mine" } },
          settings: { toolPrefix: "x" },
        }, null, 2)}\n`
        write(join(item.agentDir, "mcp.json"), existingMcp)
        write(join(item.agentDir, "skills", "keep-skill", "SKILL.md"), "mine\n")
        opencode(item, {
          mcp: {
            keep: { type: "local", command: ["theirs"] },
            fresh: { type: "local", command: ["new"] },
          },
        }, ["keep-skill"])

        const result = run(item, ["setup", "--yes"])

        expect(result.status).toBe(0)
        expect(mcp(item).mcpServers).toEqual({
          keep: { type: "stdio", command: "mine" },
          fresh: { type: "stdio", command: "new" },
        })
        expect(mcp(item).settings).toEqual({ toolPrefix: "x" })
        expect(readFileSync(join(item.agentDir, "skills", "keep-skill", "SKILL.md"), "utf8")).toBe("mine\n")
        expect(result.stdout).toContain("mcp-skipped-existing: 1")
        expect(result.stdout).toContain("skills-skipped-existing: 1")
        expect(readdirSync(item.agentDir).some((name) => name.startsWith("mcp.json.bak-"))).toBe(true)
      })
    })
  })

  describe("#given a dry run", () => {
    describe("#when setup previews the assets", () => {
      test("#then nothing is written and the preview names them", () => {
        const item = fixture()
        opencode(item, { mcp: { preview: { type: "local", command: ["x"] } } }, ["preview-skill"])

        const result = run(item, ["setup", "--dry-run"])

        expect(result.status).toBe(0)
        expect(existsSync(join(item.agentDir, "mcp.json"))).toBe(false)
        expect(existsSync(join(item.agentDir, "skills"))).toBe(false)
        expect(result.stdout).toContain("planned-mcp: preview")
        expect(result.stdout).toContain("planned-skills: preview-skill")
      })
    })
  })

  describe("#given setup runs twice", () => {
    describe("#when the second run finds nothing new", () => {
      test("#then the imported files are byte-identical", () => {
        const item = fixture()
        opencode(item, { mcp: { once: { type: "local", command: ["x"] } } }, ["once-skill"])

        run(item, ["setup", "--yes"])
        const afterFirst = readFileSync(join(item.agentDir, "mcp.json"), "utf8")
        const files = readdirSync(item.agentDir)

        const second = run(item, ["setup", "--yes"])

        expect(second.status).toBe(0)
        expect(second.stdout).toContain("mcp-imported: 0")
        expect(readFileSync(join(item.agentDir, "mcp.json"), "utf8")).toBe(afterFirst)
        expect(readdirSync(item.agentDir)).toEqual(files)
      })
    })
  })
})
