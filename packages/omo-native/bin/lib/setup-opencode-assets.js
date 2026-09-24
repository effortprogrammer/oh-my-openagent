/**
 * Reads the OpenCode user-scope config and skill tree and converts what it finds into the shapes
 * the engine's global `mcp.json` and global skill root accept. Read-only: nothing here writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJsonc } from "./jsonc.js"

// `interpolateString` in the engine's mcp config rejects any value that looks like command
// substitution, and one bad value fails the whole file - so such a server is dropped, not copied.
const REJECTED_BY_ENGINE = /\$\(/

export function opencodeConfigDir(home, env) {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

function readConfig(configDir, notices) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    try {
      const parsed = parseJsonc(readFileSync(path, "utf8"))
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
      notices.push(`WARN opencode: ${name} is not an object; mcp servers not imported`)
    } catch (error) {
      notices.push(`WARN opencode: could not parse ${name}: ${error.message}`)
    }
    return undefined
  }
  return undefined
}

// OpenCode substitutes `{env:NAME}`; the engine substitutes `${NAME}`. Same intent, same value.
function convertPlaceholders(value) {
  return typeof value === "string" ? value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}") : value
}

function convertRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined
  const entries = Object.entries(record).filter(([, value]) => typeof value === "string")
  return entries.length > 0 ? Object.fromEntries(entries.map(([key, value]) => [key, convertPlaceholders(value)])) : undefined
}

function disabled(entry) {
  return entry.enabled === false ? { enabled: false } : {}
}

function convertLocal(entry) {
  const command = Array.isArray(entry.command) ? entry.command.filter((part) => typeof part === "string") : []
  if (command.length === 0) return undefined
  const env = convertRecord(entry.environment)
  return {
    type: "stdio",
    command: convertPlaceholders(command[0]),
    ...(command.length > 1 ? { args: command.slice(1).map(convertPlaceholders) } : {}),
    ...(env ? { env } : {}),
    ...disabled(entry),
  }
}

function convertRemote(entry) {
  if (typeof entry.url !== "string" || entry.url.trim() === "") return undefined
  const headers = convertRecord(entry.headers)
  return {
    type: "http",
    url: convertPlaceholders(entry.url),
    ...(headers ? { headers } : {}),
    // OpenCode's `oauth: false` disables OAuth auto-detection; the engine spells that `auth: false`.
    ...(entry.oauth === false ? { auth: false } : {}),
    ...disabled(entry),
  }
}

function convertServer(name, entry, notices) {
  if (entry === null || typeof entry !== "object") return undefined
  const config = entry.type === "remote" ? convertRemote(entry) : convertLocal(entry)
  if (!config) {
    notices.push(`NOTICE opencode: mcp server ${name} has no usable command or url; not imported`)
    return undefined
  }
  if (REJECTED_BY_ENGINE.test(JSON.stringify(config))) {
    notices.push(`NOTICE opencode: mcp server ${name} uses command substitution, which omo refuses to run; not imported`)
    return undefined
  }
  return config
}

function readSkills(configDir) {
  const skills = []
  for (const directory of ["skills", "skill"]) {
    const root = join(configDir, directory)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const source = join(root, entry.name)
      if (!existsSync(join(source, "SKILL.md"))) continue
      if (skills.some((skill) => skill.name === entry.name)) continue
      skills.push({ name: entry.name, source })
    }
  }
  // readdir order is filesystem-dependent; the printed plan and the import order must not be.
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

export function planOpencodeAssets(options = {}) {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const configDir = opencodeConfigDir(home, env)
  const notices = []
  const mcpServers = []
  if (existsSync(configDir)) {
    const config = readConfig(configDir, notices)
    const declared = config?.mcp
    if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {
      for (const [name, entry] of Object.entries(declared)) {
        const converted = convertServer(name, entry, notices)
        if (converted) mcpServers.push({ name, config: converted })
      }
    }
  }
  return { mcpServers, skills: existsSync(configDir) ? readSkills(configDir) : [], notices }
}
