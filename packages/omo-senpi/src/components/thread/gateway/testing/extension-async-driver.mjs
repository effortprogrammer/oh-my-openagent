import assert from "node:assert/strict"
import { createGatewayHarness } from "./harness.ts"
const scenario = process.argv[2]
const h = createGatewayHarness()
const store = h.store()
const failingModule = new URL("./store-extension-async-failures.mjs", import.meta.url).href
const healthyModule = new URL("./store-extension.mjs", import.meta.url).href
const registration = (name, moduleUrl) => ({ name, moduleUrl, migrations: [[`CREATE TABLE ${name}_items (id INTEGER PRIMARY KEY, value TEXT)`, `INSERT INTO ${name}_items VALUES (0, 'seed')`]] })
let timer
let unsubscribe = () => {}
try {
  assert.equal((await store.registerStoreExtension(registration("alpha", failingModule))).kind, "ok")
  assert.equal((await store.registerStoreExtension(registration("beta", healthyModule))).kind, "ok")
  const failed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("missing attributed async_failure event")), 5000)
    unsubscribe = store.onEvent((event) => {
      if (event.kind === "extension_error" && event.phase === "async_failure" && event.extension === "alpha") resolve()
    })
  })
  const outcome = await store.extensionCall("alpha", scenario, { name: "alpha" })
  await failed
  clearTimeout(timer)
  if (scenario === "failWhileActive") {
    assert.equal(outcome.kind, "refused")
    assert.equal(outcome.code, "extension_operation_failed")
    const reopened = h.store()
    await reopened.registerStoreExtension(registration("alpha", failingModule))
    assert.deepEqual(await reopened.extensionCall("alpha", "rows", { name: "alpha" }), { kind: "ok", value: [{ id: 0, value: "seed" }] })
  } else assert.deepEqual(outcome, { kind: "ok", value: "scheduled" })
  assert.deepEqual(await store.list(), [])
  assert.equal((await store.extensionCall("alpha", "rows", { name: "alpha" })).code, "extension_disabled")
  assert.equal((await store.registerStoreExtension(registration("alpha", failingModule))).code, "extension_disabled")
  assert.deepEqual(await store.extensionCall("beta", "rows", { name: "beta" }), { kind: "ok", value: [{ id: 0, value: "seed" }] })
  console.log(JSON.stringify({ scenario, core: "serving", extension: "disabled", other: "serving" }))
} finally {
  clearTimeout(timer)
  unsubscribe()
  await h.dispose()
}
