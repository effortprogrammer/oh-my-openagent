import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { gatewayInboxDirectory, gatewayRootDirectory } from "./paths"
import { createGatewayRelay } from "./relay"
import { createGatewayHarness, type GatewayHarness } from "./testing/harness"

let harness: GatewayHarness | undefined
afterEach(async () => { await harness?.dispose(); harness = undefined })
const moduleUrl = new URL("./testing/extension-lifecycle.mjs", import.meta.url).href
const bind = (session: string) => ({
  principal: "fixture", binding: { platform: "custom", account_id: "bot", chat_id: session, session_durable_id: session, ttl_seconds: null },
})

test.each([false, true])("#given target session presence %s #when relay and tx enqueue share a binding #then target validation agrees", async (present) => {
  const h = (harness = createGatewayHarness())
  if (present) h.phantom("target")
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [] })
  const relay = createGatewayRelay({ store, engine: h.engineFor(store), endpoints: { wake: async () => { throw new Error("offline") } }, locate: async () => null })
  try {
    const bound = await relay.bind(bind("target"))
    if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
    const direct = await relay.inbound({ binding_id: bound.binding.binding_id, event_id: "direct", text: "hello" })
    const joined = await store.extensionCall("alpha", "core", { op: "enqueue", request: { binding_id: bound.binding.binding_id, event_id: "joined", text: "hello" } })
    if (present) {
      expect(direct).toMatchObject({ kind: "ok", thread_id: "target" })
      expect(joined).toMatchObject({ kind: "ok", value: { kind: "ok", thread_id: "target" } })
    } else {
      expect(direct).toMatchObject({ kind: "error", error: { code: "not_found" } })
      expect(joined).toMatchObject({ kind: "ok", value: { kind: "error", error: { code: "not_found" } } })
      expect(await store.list()).toEqual([])
    }
  } finally { relay.dispose() }
})

test("#given a blocked inbox path #when joined enqueue cannot notify #then all writes roll back with a notification refusal", async () => {
  const h = (harness = createGatewayHarness())
  h.phantom("blocked")
  h.phantom("healthy")
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [] })
  mkdirSync(join(gatewayRootDirectory(h.agentDir), "inbox"), { recursive: true })
  writeFileSync(gatewayInboxDirectory(h.agentDir, "blocked"), "not a directory")
  // Create a healthy marker first, then fail: rollback must clean up both its row and marker.
  const outcome = await store.extensionCall("alpha", "enqueuePair", [bind("healthy"), bind("blocked")])
  expect(outcome).toMatchObject({ kind: "refused", code: "extension_notification_failed" })
  expect(await store.list()).toEqual([])
  expect(readdirSync(gatewayInboxDirectory(h.agentDir, "healthy"))).toEqual([])
})

test("#given joined enqueue #when the operation has not returned #then its wake marker already exists", async () => {
  const h = (harness = createGatewayHarness())
  h.phantom("target")
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [] })
  expect(await store.extensionCall("alpha", "enqueueAndInspect", {
    binding: bind("target"), inbox: gatewayInboxDirectory(h.agentDir, "target"),
  })).toEqual({ kind: "ok", value: { markers: 1 } })
  expect(await store.list()).toHaveLength(1)
})

test("#given a blocked marker removal #when rebind commits #then its result reports cleanup failure without refusing committed data", async () => {
  const h = (harness = createGatewayHarness())
  h.phantom("target")
  const store = h.store()
  await store.registerStoreExtension({ name: "alpha", moduleUrl, migrations: [] })
  const bound = await store.extensionCall<{ kind: "ok"; binding: { binding_id: string } }>("alpha", "core", { op: "bind", request: bind("target") })
  if (bound.kind !== "ok") throw new Error(JSON.stringify(bound))
  const bindingId = bound.value.binding.binding_id
  await store.extensionCall("alpha", "core", { op: "enqueue", request: { binding_id: bindingId, event_id: "first", text: "hello" } })
  const [row] = await store.list()
  const marker = join(gatewayInboxDirectory(h.agentDir, "target"), row.delivery_id)
  rmSync(marker)
  mkdirSync(marker)
  const outcome = await store.extensionCall("alpha", "core", {
    op: "rebind", request: { principal: "fixture", binding_id: bindingId, expected_revision: 1, session_durable_id: "next" },
  })
  expect(outcome).toMatchObject({ kind: "ok", value: { kind: "ok", binding: { session_durable_id: "next" } }, notification_errors: [expect.any(String)] })
  expect((await store.bindingView({ now: h.clock.now, binding_id: bindingId }))?.session_durable_id).toBe("next")
  expect(existsSync(marker)).toBe(true)
})
