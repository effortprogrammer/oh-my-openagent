import { homedir } from "node:os"
import { bunWhich } from "../../shared/bun-which-shim"
import { spawnWithWindowsHide } from "../../shared/spawn-with-windows-hide"
import { legacyOmoBins, resolveOmoBinEnvironment, scanOmoBins } from "./legacy-omo-bin"
import type { OmoBinEnvironment } from "./legacy-omo-bin"
import { removeFileCommand, repairLegacyOmoBins } from "./repair-legacy-omo-bin"
import { verifyOmoCommand } from "./verify-omo-command"
import type { OmoVersionProbe } from "./verify-omo-command"
import {
  formatNativeInstallCommand,
  NATIVE_RECOMMENDED_RUNTIME_NOTE,
  NATIVE_SETUP_COMMAND,
  resolveNativeInstallPlan,
} from "./plan"
import type { NativeInstallPlan } from "./plan"

export interface NativeInstallSpawnResult {
  readonly exitCode: number
  readonly stderr?: string
}

export type NativeInstallSpawn = (
  command: string,
  args: readonly string[],
) => Promise<NativeInstallSpawnResult>

export interface NativeInstallDependencies {
  readonly isBunAvailable: () => boolean | Promise<boolean>
  readonly spawn: NativeInstallSpawn
  readonly environment: OmoBinEnvironment
  readonly probeVersion: OmoVersionProbe
}

export interface NativeInstallFailure {
  readonly reason: string
  readonly manualCommand: string
  readonly hints?: readonly string[]
}

export interface NativeInstallOutcome {
  readonly ok: boolean
  /** The `omo` that PATH resolves after the install is the one omo-ai owns. */
  readonly verified: boolean
  readonly plan: NativeInstallPlan
  readonly notes: readonly string[]
  readonly warnings: readonly string[]
  readonly failure?: NativeInstallFailure
}

function describeExit(plan: NativeInstallPlan, result: NativeInstallSpawnResult): string {
  const stderr = result.stderr?.trim()
  const head = `${plan.packageManager} exited with code ${result.exitCode}`
  return stderr ? `${head}: ${stderr.split("\n").slice(-3).join(" ")}` : head
}

export async function runNativeInstall(
  dependencies: NativeInstallDependencies = defaultNativeInstallDependencies(),
): Promise<NativeInstallOutcome> {
  const plan = resolveNativeInstallPlan(await dependencies.isBunAvailable())
  const environment = dependencies.environment
  const notes = plan.packageManager === "npm" ? [NATIVE_RECOMMENDED_RUNTIME_NOTE] : []
  const warnings: string[] = []
  const manualCommand = formatNativeInstallCommand(plan)

  // A pre-rename release owns the global `omo` name. npm refuses to overwrite it (EEXIST) and bun
  // installs beside it, so the repair has to happen before the package manager runs either way.
  const repair = repairLegacyOmoBins(legacyOmoBins(scanOmoBins(environment)), { isWindows: environment.isWindows })
  notes.push(...repair.notes)
  warnings.push(...repair.warnings)
  const hints = repair.failures.map(
    (failure) =>
      `Remove the stale omo command first: ${removeFileCommand(failure.binPath, environment.isWindows)}`,
  )

  const failed = (reason: string): NativeInstallOutcome => ({
    ok: false,
    verified: false,
    plan,
    notes,
    warnings,
    failure: hints.length > 0 ? { reason, manualCommand, hints } : { reason, manualCommand },
  })

  try {
    const result = await dependencies.spawn(plan.command, plan.args)
    if (result.exitCode !== 0) return failed(describeExit(plan, result))
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }

  const verification = await verifyOmoCommand({ environment, probeVersion: dependencies.probeVersion })
  notes.push(...verification.notes)
  warnings.push(...verification.warnings)
  return { ok: true, verified: verification.ok, plan, notes, warnings }
}

export function nativeInstallSuccessLine(): string {
  return `OmO Native installed. Run ${NATIVE_SETUP_COMMAND} to finish onboarding.`
}

export function nativeInstallFailureLines(failure: NativeInstallFailure): readonly string[] {
  return [
    `OmO Native install failed: ${failure.reason}`,
    ...(failure.hints ?? []),
    `Install it yourself with: ${failure.manualCommand}`,
    `Then run ${NATIVE_SETUP_COMMAND}.`,
  ]
}

function defaultNativeInstallDependencies(): NativeInstallDependencies {
  return {
    isBunAvailable: () => bunWhich("bun") !== null,
    environment: resolveOmoBinEnvironment({ env: process.env, platform: process.platform, homeDir: homedir() }),
    spawn: async (command, args) => {
      const proc = spawnWithWindowsHide([command, ...args], {
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      })
      return { exitCode: await proc.exited }
    },
    probeVersion: async (command, args) => {
      const proc = spawnWithWindowsHide([command, ...args], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = proc.stdout === undefined ? "" : await new Response(proc.stdout).text()
      return { exitCode: await proc.exited, stdout }
    },
  }
}
