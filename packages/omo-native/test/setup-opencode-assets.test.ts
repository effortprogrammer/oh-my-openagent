import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { planOpencodeAssets } from "../bin/lib/setup-opencode-assets.js"
import { teardownRoots } from "./teardown.test-support"

const roots: string[] = []

afterEach(() => teardownRoots(roots))

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture(config: unknown, options: { jsonc?: string, skills?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omo-assets-"))
  roots.push(root)
  const home = join(root, "home")
  const configDir = join(root, "config", "opencode")
  mkdirSync(home, { recursive: true })
  if (options.jsonc !== undefined) write(join(configDir, "opencode.jsonc"), options.jsonc)
  if (config !== undefined) write(join(configDir, "opencode.json"), JSON.stringify(config, null, 2))
  for (const name of options.skills ?? []) {
    write(join(configDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n\nbody\n`)
  }
  return planOpencodeAssets({ home, env: { XDG_CONFIG_HOME: join(root, "config") } })
}

describe("opencode asset plan", () => {
  describe("#given a local mcp server", () => {
    describe("#when it is planned", () => {
      test("#then the command array splits into the engine's command and args", () => {
        const plan = fixture({
          mcp: {
            "my-tool": {
              type: "local",
              command: ["bun", "x", "my-mcp", "--flag"],
              environment: { TOKEN: "{env:MY_TOKEN}" },
              enabled: false,
            },
          },
        })

        expect(plan.mcpServers).toEqual([{
          name: "my-tool",
          config: {
            type: "stdio",
            command: "bun",
            args: ["x", "my-mcp", "--flag"],
            env: { TOKEN: "${MY_TOKEN}" },
            enabled: false,
          },
        }])
      })
    })
  })

  describe("#given a remote mcp server", () => {
    describe("#when it is planned", () => {
      test("#then it becomes an http server and an explicit oauth opt-out is preserved", () => {
        const plan = fixture({
          mcp: {
            remote: { type: "remote", url: "https://example.test/mcp", headers: { A: "b" }, oauth: false },
          },
        })

        expect(plan.mcpServers).toEqual([{
          name: "remote",
          config: { type: "http", url: "https://example.test/mcp", headers: { A: "b" }, auth: false },
        }])
      })
    })
  })

  describe("#given a value the engine's interpolation rejects", () => {
    describe("#when it is planned", () => {
      test("#then the server is dropped with a notice instead of breaking every mcp load", () => {
        const plan = fixture({
          mcp: {
            risky: { type: "local", command: ["sh", "-c", "echo $(whoami)"] },
            safe: { type: "local", command: ["true"] },
          },
        })

        expect(plan.mcpServers.map((server) => server.name)).toEqual(["safe"])
        expect(plan.notices.join("\n")).toContain("risky")
      })
    })
  })

  describe("#given an opencode.jsonc with comments and a trailing comma", () => {
    describe("#when it is planned", () => {
      test("#then it parses", () => {
        const plan = fixture(undefined, {
          jsonc: `{\n  // a comment\n  "mcp": {\n    "c": { "type": "remote", "url": "https://c.test/mcp" },\n  },\n}\n`,
        })

        expect(plan.mcpServers.map((server) => server.name)).toEqual(["c"])
      })
    })
  })

  describe("#given a url containing // inside an opencode.jsonc string", () => {
    describe("#when it is planned", () => {
      test("#then the scheme separator is not treated as a comment", () => {
        const plan = fixture(undefined, {
          jsonc: `{\n  "mcp": {\n    "u": { "type": "remote", "url": "https://example.test/mcp" } // trailing\n  }\n}\n`,
        })

        expect(plan.mcpServers).toEqual([{
          name: "u",
          config: { type: "http", url: "https://example.test/mcp" },
        }])
      })
    })
  })

  describe("#given global opencode skills", () => {
    describe("#when they are planned", () => {
      test("#then each skill directory is listed by name", () => {
        const plan = fixture({}, { skills: ["alpha", "beta"] })

        expect(plan.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"])
      })
    })
  })

  describe("#given no opencode config at all", () => {
    describe("#when it is planned", () => {
      test("#then the plan is empty and silent", () => {
        const plan = fixture(undefined)

        expect(plan).toEqual({ mcpServers: [], skills: [], notices: [] })
      })
    })
  })
})
