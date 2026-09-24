/**
 * Classifies and writes the OpenCode assets `setup-opencode-assets.js` planned: MCP servers into
 * the engine's GLOBAL `<agentDir>/mcp.json` (the one config source the engine always trusts) and
 * skills into the GLOBAL `<agentDir>/skills` root. A name that already exists is never overwritten.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { planOpencodeAssets } from "./setup-opencode-assets.js"

function readMcpTarget(path) {
  if (!existsSync(path)) return { document: {}, bytes: undefined }
  const bytes = readFileSync(path, "utf8")
  try {
    const document = JSON.parse(bytes)
    if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Error("expected object")
    return { document, bytes }
  } catch {
    return { malformed: true, bytes }
  }
}

function classifyAssets(plan, paths) {
  const target = readMcpTarget(paths.mcp)
  const existingServers = target.malformed ? {} : (target.document.mcpServers ?? {})
  const servers = { added: [], skippedExisting: [], blocked: [] }
  for (const server of plan.mcpServers) {
    if (target.malformed) servers.blocked.push(server.name)
    else if (Object.hasOwn(existingServers, server.name)) servers.skippedExisting.push(server.name)
    else servers.added.push(server)
  }
  const skills = { added: [], skippedExisting: [] }
  for (const skill of plan.skills) {
    if (existsSync(join(paths.skills, skill.name))) skills.skippedExisting.push(skill.name)
    else skills.added.push(skill)
  }
  return { servers, skills, target }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "")
}

function writeMcp(path, target, added) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (target.bytes !== undefined) copyFileSync(path, `${path}.bak-${timestamp()}`)
  const next = { ...target.document, mcpServers: { ...(target.document.mcpServers ?? {}) } }
  for (const server of added) next.mcpServers[server.name] = server.config
  const temporary = `${path}.tmp-${process.pid}`
  try {
    // Server env and headers can carry tokens, so this file gets the same 0600 the auth store does.
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function writeAssets(result, paths) {
  if (result.servers.added.length > 0) writeMcp(paths.mcp, result.target, result.servers.added)
  for (const skill of result.skills.added) {
    // force: false is the no-overwrite guarantee itself - cpSync leaves an existing file alone.
    cpSync(skill.source, join(paths.skills, skill.name), { recursive: true, force: false })
  }
}

function list(label, ids) {
  return `${label}: ${ids.length > 0 ? ids.join(", ") : "none"}`
}

function formatAssetPlan(result) {
  const blocked = result.servers.blocked.length > 0
    ? `WARN senpi: malformed mcp.json; these servers were not imported: ${result.servers.blocked.join(", ")}\n`
    : ""
  return blocked + `${[
    list("planned-mcp", result.servers.added.map((server) => server.name)),
    list("mcp-skipped-existing", result.servers.skippedExisting),
    list("planned-skills", result.skills.added.map((skill) => skill.name)),
    list("skills-skipped-existing", result.skills.skippedExisting),
  ].join("\n")}\n`
}

function formatAssetCounts(result) {
  return `${[
    `mcp-imported: ${result.servers.added.length}`,
    `mcp-skipped-existing: ${result.servers.skippedExisting.length}`,
    `skills-imported: ${result.skills.added.length}`,
    `skills-skipped-existing: ${result.skills.skippedExisting.length}`,
  ].join("\n")}\n`
}

/**
 * The asset stage of `omo setup`: same detect -> preview -> consent -> write shape the credential
 * stage uses. `confirm` is the caller's consent prompt, so both stages ask the same way.
 */
export async function importOpencodeAssets(stage) {
  const plan = planOpencodeAssets(stage.runtime)
  for (const notice of plan.notices) process.stdout.write(`${notice}\n`)
  if (plan.mcpServers.length === 0 && plan.skills.length === 0) return
  const paths = { mcp: join(stage.agentDir, "mcp.json"), skills: join(stage.agentDir, "skills") }
  const result = classifyAssets(plan, paths)
  process.stdout.write(formatAssetPlan(result))
  if (stage.args.includes("--dry-run")) return
  const pending = result.servers.added.length + result.skills.added.length
  if (pending > 0 && !await stage.confirm(
    `Import ${result.servers.added.length} MCP server(s) and ${result.skills.added.length} skill(s) into ${stage.agentDir}? [y/N] `,
  )) {
    return
  }
  writeAssets(result, paths)
  process.stdout.write(formatAssetCounts(result))
}
