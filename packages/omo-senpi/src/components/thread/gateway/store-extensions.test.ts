import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { gatewayDatabasePath, gatewayInboxDirectory } from "./paths"
import { GATEWAY_MIGRATIONS } from "./schema"
import type { StoreExtensionRegistration } from "./store-extensions"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })

const moduleUrl = new URL("./testing/store-extension.mjs", import.meta.url).href
const extension = (name = "alpha"): StoreExtensionRegistration => ({
  name, moduleUrl,
  migrations: [[`CREATE TABLE ${name}_items (id INTEGER PRIMARY KEY, value TEXT)`, `INSERT INTO ${name}_items VALUES (0, 'seed')`]],
})
const bind = { principal: "connector:test", binding: { platform: "custom", account_id: "bot", chat_id: "chat", session_durable_id: "target", ttl_seconds: null } }

/** What each core migration after v6 added, undone in reverse to bring a current store back to that version. */
const CORE_AFTER_V6: readonly (readonly string[])[] = [
  ["DELETE FROM extension_objects WHERE owner IS NULL AND name IN ('session_models', 'sqlite_autoindex_session_models_1')", "DROP TABLE session_models"],
  ["ALTER TABLE session_models DROP COLUMN revision"],
  ["ALTER TABLE session_models DROP COLUMN pending_set_by", "ALTER TABLE session_models DROP COLUMN pending_model_id", "ALTER TABLE session_models DROP COLUMN pending_provider"],
]

/**
 * A store at core `version` (6 or later) holding extension `alpha`: the real store registers it (its
 * ownership recorder is the one v6 shipped, lower-casing what the migration created), then the core
 * migrations after `version` are undone. A migration missing from CORE_AFTER_V6 fails the reopen loudly.
 */
async function storeAtVersion(h: GatewayHarness, version: number, migration: readonly string[]): Promise<void> {
  const store = h.store()
  expect(await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [migration] })).toEqual({ kind: "ok", value: { version: 1 } })
  await store.dispose()
  const db = new Database(gatewayDatabasePath(h.agentDir))
  try {
    for (const step of CORE_AFTER_V6.slice(version - 6).reverse()) for (const statement of step) db.run(statement)
    db.run(`PRAGMA user_version = ${version}`)
  } finally {
    db.close()
  }
}

describe("store extension migrations", () => {
  // Storage/migration contract: a core migration after v6 reserves its own objects without taking over,
  // or shadowing, what an extension already owns, whatever case the extension's DDL used.
  test("#given a v6 store holding an extension created with mixed-case DDL #when the current store opens it #then the extension registers again with its rows and no core row shadows its objects", async () => {
    const h = (harness = createGatewayHarness())
    const migration = ["CREATE TABLE Alpha_Items (id TEXT PRIMARY KEY, value TEXT)", "INSERT INTO Alpha_Items VALUES ('k', 'preserved')"]
    await storeAtVersion(h, 6, migration)
    // Each core step after v6 on its own (a later cleanup must not hide a step that shadows).
    const steps = new Database(gatewayDatabasePath(h.agentDir))
    try {
      steps.run("BEGIN")
      for (const [index, step] of GATEWAY_MIGRATIONS.slice(6).entries()) {
        for (const statement of step) steps.run(statement)
        expect({ version: 7 + index, shadows: steps.query("SELECT core.type, core.name FROM extension_objects core JOIN extension_objects owned ON owned.owner IS NOT NULL AND owned.type = core.type AND owned.name = core.name COLLATE NOCASE WHERE core.owner IS NULL").all() }).toEqual({ version: 7 + index, shadows: [] })
      }
      steps.run("ROLLBACK")
    } finally { steps.close() }
    const store = h.store()
    const registration = { name: "alpha", moduleUrl, migrations: [migration] }
    expect(await store.registerStoreExtension(registration)).toEqual({ kind: "ok", value: { version: 1 } })
    expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [{ id: "k", value: "preserved" }] })
    const db = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: GATEWAY_MIGRATIONS.length })
      expect(db.query("SELECT type, name, owner FROM extension_objects WHERE name LIKE '%alpha_items%' ORDER BY type, name").all()).toEqual([
        { type: "index", name: "sqlite_autoindex_alpha_items_1", owner: "alpha" }, { type: "table", name: "alpha_items", owner: "alpha" },
      ])
      expect(db.query("SELECT owner FROM extension_objects WHERE type = 'table' AND name = 'session_models'").get()).toEqual({ owner: null })
    } finally { db.close() }
  })

  test("#given a v8 store whose v7 reserved a mixed-case extension table as core #when the current store opens it #then the shadowing core row is dropped and the extension registers again", async () => {
    const h = (harness = createGatewayHarness())
    const migration = ["CREATE TABLE Alpha_Items (id INTEGER PRIMARY KEY, value TEXT)"]
    await storeAtVersion(h, 8, migration)
    // What the case-sensitive v7 reservation left behind on a store it upgraded from v6.
    const db = new Database(gatewayDatabasePath(h.agentDir))
    try { db.run("INSERT INTO extension_objects (type, name, owner) VALUES ('table', 'Alpha_Items', NULL)") } finally { db.close() }
    const store = h.store()
    expect(await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [migration] })).toEqual({ kind: "ok", value: { version: 1 } })
    const read = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
    try {
      expect(read.query("SELECT name, owner FROM extension_objects WHERE name LIKE '%alpha_items%' ORDER BY name").all()).toEqual([{ name: "alpha_items", owner: "alpha" }])
    } finally { read.close() }
  })

  test("#given a core table added after the v6 snapshot #when an extension takes its name #then registration is refused and the table stays core", async () => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    const result = await store.registerStoreExtension(extension("session_models"))
    expect(result).toMatchObject({ kind: "refused", code: "extension_schema_violation" })
    const db = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
    try {
      expect(db.query("SELECT owner FROM extension_objects WHERE type = 'table' AND name = 'session_models'").get()).toEqual({ owner: null })
      expect(db.query("SELECT name FROM extension_schema").all()).toEqual([])
    } finally {
      db.close()
    }
  })

  test("#given an extension #when registered and called repeatedly #then its migration applies once and core version stays five", async () => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    expect(await store.registerStoreExtension(extension())).toEqual({ kind: "ok", value: { version: 1 } })
    expect(await store.registerStoreExtension(extension())).toEqual({ kind: "ok", value: { version: 1 } })
    expect(await store.extensionCall("alpha", "put", { name: "alpha", id: 1, value: "kept" })).toEqual({ kind: "ok", value: { value: "kept" } })
    expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [{ id: 0, value: "seed" }, { id: 1, value: "kept" }] })
    const db = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
    try {
      expect(db.query("SELECT name, version FROM extension_schema").all()).toEqual([{ name: "alpha", version: 1 }])
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: GATEWAY_MIGRATIONS.length })
    } finally { db.close() }
  })

  test("#given two namespaces #when their operations run #then their rows do not collide and cross reads fail", async () => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    for (const name of ["alpha", "beta"]) expect((await store.registerStoreExtension(extension(name))).kind).toBe("ok")
    expect((await store.extensionCall("alpha", "put", { name: "alpha", id: 1, value: "alpha only" })).kind).toBe("ok")
    expect(await store.extensionCall("beta", "rows", { name: "beta" })).toEqual({ kind: "ok", value: [{ id: 0, value: "seed" }] })
    expect(await store.extensionCall("beta", "rows", { name: "alpha" })).toMatchObject({ kind: "refused", code: "extension_schema_violation" })
    expect(await store.journalMode()).toBe("wal")
  })

  test.each([
    ["unprefixed table", "CREATE TABLE outsider (id INTEGER)"],
    ["core alter", "ALTER TABLE deliveries ADD COLUMN stolen TEXT"],
    ["trigger attached to core", "CREATE TRIGGER alpha_hook AFTER INSERT ON deliveries BEGIN SELECT 1; END"],
    ["trigger writing core", "CREATE TRIGGER alpha_hook AFTER INSERT ON alpha_items BEGIN DELETE FROM deliveries; END"],
    ["rename outside namespace", "ALTER TABLE alpha_items RENAME TO outsider"],
    ["core drop", "DROP TABLE deliveries"],
    ["core view", "CREATE VIEW alpha_view AS SELECT * FROM receipts"],
    ["schema version", "PRAGMA user_version = 900"],
    ["transaction escape", "COMMIT"],
  ])("#given a forbidden %s #when migrating #then the step rolls back and the worker serves core operations", async (_label, statement) => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    const descriptor = extension()
    const result = await store.registerStoreExtension({ ...descriptor, migrations: [[...descriptor.migrations[0], statement]] })
    expect(result).toMatchObject({ kind: "refused", code: "extension_schema_violation", message: expect.any(String) })
    expect(await store.journalMode()).toBe("wal")
    const db = new Database(gatewayDatabasePath(h.agentDir), { readonly: true })
    try {
      expect(db.query("SELECT name FROM sqlite_schema WHERE name IN ('alpha_items', 'outsider', 'alpha_hook', 'alpha_view')").all()).toEqual([])
      expect(db.query("SELECT * FROM extension_schema").all()).toEqual([])
      expect(db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 })
    } finally { db.close() }
  })
})

describe("store extension calls", () => {
  test.each([
    "SELECT * FROM receipts",
    "UPDATE deliveries SET body = 'changed'",
    "CREATE TABLE outsider (id INTEGER)",
    "ALTER TABLE alpha_items RENAME TO outsider",
    "CREATE TRIGGER alpha_bad AFTER INSERT ON alpha_items BEGIN DELETE FROM receipts; END",
    "SELECT value FROM json_each('[1,2]')",
  ])("#given forbidden SQL %s #when called #then a typed refusal leaves the worker usable", async (sql) => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    expect((await store.registerStoreExtension(extension())).kind).toBe("ok")
    expect(await store.extensionCall("alpha", "sql", { sql })).toMatchObject({ kind: "refused", code: "extension_schema_violation" })
    expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [{ id: 0, value: "seed" }] })
    expect(await store.list()).toEqual([])
  })

  test.each([
    ["schema denial", "DROP TABLE deliveries", "extension_schema_violation"],
    ["constraint error", "INSERT INTO alpha_items VALUES (0, 'duplicate')", "extension_operation_failed"],
  ])("#given a module catches a %s #when returning #then the whole transaction still rolls back", async (_kind, sql, code) => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    await store.registerStoreExtension(extension())
    expect(await store.extensionCall("alpha", "swallow", { before: "INSERT INTO alpha_items VALUES (1, 'uncommitted')", sql })).toMatchObject({ kind: "refused", code })
    expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [{ id: 0, value: "seed" }] })
    expect(await store.list()).toEqual([])
  })

  test("#given missing module name and op #when requested #then all refusals are typed and core requests still succeed", async () => {
    const h = (harness = createGatewayHarness())
    const store = h.store()
    expect(await store.registerStoreExtension({ ...extension(), moduleUrl: new URL("./missing.mjs", import.meta.url).href })).toMatchObject({ kind: "refused", code: "extension_import_failed", message: expect.any(String) })
    expect(await store.list()).toEqual([])
    expect(await store.extensionCall("missing", "rows", {})).toMatchObject({ kind: "refused", code: "extension_unknown_name", message: expect.any(String) })
    expect(await store.journalMode()).toBe("wal")
    await store.registerStoreExtension(extension())
    expect(await store.extensionCall("alpha", "missing", {})).toMatchObject({ kind: "refused", code: "extension_unknown_op", message: expect.any(String) })
    expect(await store.list()).toEqual([])
  })

  test("#given an enqueue followed by a throw #when the op fails #then extension core rows and markers all roll back", async () => {
    const h = (harness = createGatewayHarness())
    h.phantom("target")
    const store = h.store()
    await store.registerStoreExtension(extension())
    const bound = await store.extensionCall<{ kind: "ok"; binding: { binding_id: string } }>("alpha", "core", { op: "bind", request: bind })
    if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
    const result = await store.extensionCall("alpha", "enqueueThenThrow", { request: { binding_id: bound.value.binding.binding_id, event_id: "rolled-back", text: "hello", author: { platform_user_id: "p1", display: "Alice", user_id: "u1" } }, inbox: gatewayInboxDirectory(h.agentDir, "target") })
    expect(result).toEqual({ kind: "refused", code: "extension_operation_failed", message: "rollback requested" })
    expect(await store.list()).toEqual([])
    expect(existsSync(gatewayInboxDirectory(h.agentDir, "target")) ? readdirSync(gatewayInboxDirectory(h.agentDir, "target")) : []).toEqual([])
    expect(await store.extensionCall("alpha", "rows", { name: "alpha" })).toEqual({ kind: "ok", value: [{ id: 0, value: "seed" }] })
  })

  test("#given binding and inbound in one op #when committed #then binding reads actor attribution and markers are published", async () => {
    const h = (harness = createGatewayHarness())
    h.phantom("target")
    const store = h.store()
    await store.registerStoreExtension(extension())
    const result = await store.extensionCall("alpha", "bindThenEnqueue", {
      bind, address: { platform: "custom", account_id: "bot", chat_id: "chat", thread_id: "@chat" },
      send: { event_id: "sent", text: "hello", author: { platform_user_id: "p1", display: "Alice", user_id: "u1" } },
    })
    expect(result).toMatchObject({ kind: "ok", value: { found: { status: "active" }, sent: { kind: "ok" } } })
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_user_id).toBe("u1")
    expect(existsSync(join(gatewayInboxDirectory(h.agentDir, "target"), rows[0].delivery_id))).toBe(true)
    const moved = await store.extensionCall("alpha", "rebindThenThrow", { request: { principal: "connector:test", binding_id: rows[0].binding_id, expected_revision: 1, session_durable_id: "target2" }, marker: join(gatewayInboxDirectory(h.agentDir, "target"), rows[0].delivery_id) })
    expect(moved).toEqual({ kind: "refused", code: "extension_operation_failed", message: "rollback requested" })
    expect((await store.list())[0].state).toBe("queued")
    expect(existsSync(join(gatewayInboxDirectory(h.agentDir, "target"), rows[0].delivery_id))).toBe(true)
  })
})
