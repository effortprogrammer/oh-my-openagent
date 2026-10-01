import { extname } from "node:path"
import { fileURLToPath } from "node:url"

import { assertExtensionName, checkExtensionSchema, ExtensionSchemaViolation, extensionSchema, extensionSql, sqliteName } from "./extension-sql"
import { extensionTransaction } from "./extension-transaction"
import { singleExtensionStatement } from "./extension-statement"
import type { GatewayResolve } from "./engine"
import { isLockWaitExceeded } from "./lock-wait"
import { GatewaySchemaVersionError } from "./schema"
import { ExtensionNotificationError, transaction, type StoreContext } from "./store-ops"
import type { StoreExtensionOperation, StoreExtensionRefusal, StoreExtensionRegistration, StoreExtensionResult } from "./store-extensions"

type Registered = {
  readonly descriptor: StoreExtensionRegistration
  readonly module: Readonly<Record<string, unknown>>
}

function refusal(code: StoreExtensionRefusal["code"], message: string): StoreExtensionRefusal {
  return { kind: "refused", code, message }
}

function fromError(error: unknown): StoreExtensionRefusal {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ExtensionSchemaViolation || error instanceof GatewaySchemaVersionError) return refusal(error.code, message)
  if (error instanceof ExtensionNotificationError) return refusal(error.code, message)
  if (isLockWaitExceeded(error)) return refusal("gateway_lock_wait_exceeded", message)
  return refusal("extension_operation_failed", message)
}

export class StoreExtensions {
  private readonly registered = new Map<string, Registered>()
  private readonly modules = new Map<string, { readonly path: string; readonly href: string }>()
  private readonly disabled = new Map<string, StoreExtensionRefusal>()
  private active: { readonly name: string; readonly fail: (error: unknown) => void } | undefined

  /**
   * Disables every registered extension whose module file appears in a late error's stack, and fails
   * its in-flight call. Bun does not carry async context into the worker's fatal-error handlers, so
   * the stack frame of the registered module is the provenance that survives.
   */
  containLateError(error: unknown): readonly string[] {
    if (!(error instanceof Error) || error.stack === undefined) return []
    const owners: string[] = []
    const frames = error.stack.split("\n")
    for (const [name, module] of this.modules) {
      if (!frames.some((frame) => frame.includes(`${module.path}:`) || frame.includes(`${module.href}:`))) continue
      owners.push(name)
      this.disabled.set(name, refusal("extension_disabled", `Extension ${name} was disabled after an asynchronous failure: ${error.message}`))
      if (this.active?.name === name) this.active.fail(error)
    }
    return owners
  }

  constructor(private readonly ctx: StoreContext, private readonly resolveTarget: GatewayResolve) {}

  async register(descriptor: StoreExtensionRegistration, now: number): Promise<StoreExtensionResult<{ readonly version: number }>> {
    const disabled = this.disabled.get(descriptor.name)
    if (disabled !== undefined) return disabled
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(descriptor.name) || !Array.isArray(descriptor.migrations)
      || !descriptor.migrations.every((step) => Array.isArray(step) && step.every((sql) => typeof sql === "string"))) {
      return refusal("invalid_arguments", "An extension needs a valid namespace and an array of SQL migration steps.")
    }
    try {
      assertExtensionName(this.ctx.sql, descriptor.name)
    } catch (error) {
      return fromError(error)
    }
    let module: Readonly<Record<string, unknown>>
    try {
      const url = new URL(descriptor.moduleUrl)
      if (url.protocol !== "file:" || ![".js", ".mjs", ".cjs"].includes(extname(url.pathname))) {
        return refusal("extension_import_failed", "moduleUrl must name a compiled JavaScript file URL.")
      }
      this.modules.set(descriptor.name, { path: fileURLToPath(url), href: url.href })
      module = await import(descriptor.moduleUrl)
    } catch (error) {
      return refusal("extension_import_failed", `Cannot import extension ${descriptor.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const failedImport = this.disabled.get(descriptor.name)
    if (failedImport !== undefined) return failedImport
    try {
      const version = await this.ensure(descriptor, now)
      this.registered.set(descriptor.name, { descriptor, module })
      return { kind: "ok", value: { version } }
    } catch (error) {
      // Migration failures remain retryable on call; a downgrade must preserve the prior registration.
      if (!(error instanceof GatewaySchemaVersionError)) this.registered.set(descriptor.name, { descriptor, module })
      return fromError(error)
    }
  }

  private async ensure(descriptor: StoreExtensionRegistration, now: number): Promise<number> {
    const { name, migrations } = descriptor
    for (;;) {
      const step = await transaction(this.ctx, "extension_migrate", () => {
        const row = this.ctx.sql.one(["version"], "SELECT version FROM extension_schema WHERE name = ?", [name])
        const version = Number(row?.version ?? 0)
        if (version > migrations.length) throw new GatewaySchemaVersionError(version, migrations.length, `Extension ${name}`)
        const before = extensionSchema(this.ctx.sql)
        if (row === undefined && before.objects.some((object) => sqliteName(String(object.name)).startsWith(`${name}_`) && before.owners.get(`${String(object.type)}:${sqliteName(String(object.name))}`) == null)) {
          throw new ExtensionSchemaViolation(`Namespace ${name} already contains unowned objects.`)
        }
        if (version === migrations.length) {
          if (row === undefined) this.ctx.sql.run("INSERT INTO extension_schema (name, version, updated_at) VALUES (?, 0, ?)", [name, now])
          return { version, applied: false }
        }
        for (const statement of migrations[version]) {
          singleExtensionStatement(statement)
          const beforeStatement = extensionSchema(this.ctx.sql)
          extensionSql(this.ctx.sql, name, () => this.ctx.sql.exec(statement))
          checkExtensionSchema(this.ctx.sql, name, beforeStatement, extensionSchema(this.ctx.sql))
        }
        checkExtensionSchema(this.ctx.sql, name, before, extensionSchema(this.ctx.sql))
        this.ctx.sql.run("INSERT INTO extension_schema (name, version, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at", [name, version + 1, now])
        return { version: version + 1, applied: true }
      })
      if (!step.applied) return step.version
    }
  }

  async call(name: string, op: string, args: unknown, now: number): Promise<StoreExtensionResult<unknown>> {
    const disabled = this.disabled.get(name)
    if (disabled !== undefined) return disabled
    const entry = this.registered.get(name)
    if (entry === undefined) return refusal("extension_unknown_name", `No store extension is registered as ${name}.`)
    const operation = Object.hasOwn(entry.module, op) ? entry.module[op] : undefined
    if (typeof operation !== "function") return refusal("extension_unknown_op", `Extension ${name} exports no operation ${op}.`)
    const effects: (() => void)[] = []
    const rollback: (() => void)[] = []
    try {
      await this.ensure(entry.descriptor, now)
      const value = await transaction(this.ctx, "extension_call", async () => {
        const before = extensionSchema(this.ctx.sql)
        const scope = extensionTransaction({ ...this.ctx, afterCommit: effects, afterRollback: rollback }, name, now, this.resolveTarget)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const run = async () => {
            try {
              return await (operation as StoreExtensionOperation)(scope.tx, args)
            } finally {
              await scope.finish()
            }
          }
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              scope.cancel()
              reject(new Error(`Extension ${name}.${op} exceeded its ${this.ctx.config.lock_wait_max_ms} ms operation budget.`))
            }, this.ctx.config.lock_wait_max_ms)
          })
          const failed = new Promise<never>((_resolve, reject) => {
            this.active = { name, fail: (error) => { scope.cancel(); reject(error) } }
          })
          const result = await Promise.race([run(), deadline, failed])
          checkExtensionSchema(this.ctx.sql, name, before, extensionSchema(this.ctx.sql))
          // Refuse uncloneable results before commit, not in the worker's response writer afterwards.
          return structuredClone(result)
        } finally {
          clearTimeout(timer)
          this.active = undefined
          scope.cancel()
        }
      })
      rollback.length = 0
      const notificationErrors: string[] = []
      for (const effect of effects) {
        try {
          effect()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          notificationErrors.push(message)
          this.ctx.emit({ kind: "extension_error", extension: name, phase: "after_commit", error: message })
        }
      }
      return { kind: "ok", value, ...(notificationErrors.length === 0 ? {} : { notification_errors: notificationErrors }) }
    } catch (error) {
      for (const cleanup of rollback) cleanup()
      return fromError(error)
    }
  }
}
