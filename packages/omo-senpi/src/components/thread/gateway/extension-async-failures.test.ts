import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Bun's test runner intercepts worker exceptions before process handlers. Exercise real worker
// semantics in a plain Bun process, as the existing extension lifecycle driver does.
test.each(["lateThrow", "lateRejection", "failWhileActive"])("#given %s in an extension #when it fails asynchronously #then it is disabled while core and other extensions serve", async (scenario) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./testing/extension-async-driver.mjs", import.meta.url)), scenario], { stdout: "pipe", stderr: "pipe" })
  const deadline = setTimeout(() => child.kill(), 10000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({ scenario, core: "serving", extension: "disabled", other: "serving" })
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 15000)
