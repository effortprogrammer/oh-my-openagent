import { describe, expect, test } from "bun:test"

import providerMap from "../bin/lib/provider-map.json"
import { formatCredentialGuidance } from "../bin/lib/setup-guidance.js"

function guidance(skippedOauth: string[], skippedUnmapped: string[]): string {
  return formatCredentialGuidance({ skippedOauth, skippedUnmapped }, providerMap)
}

describe("omo setup credential guidance", () => {
  describe("#given an OAuth credential that omo signs in for", () => {
    describe("#when the guidance renders", () => {
      test("#then it names the interactive /login command and the engine provider id", () => {
        const text = guidance(["openai", "anthropic", "github-copilot"], [])

        expect(text).toContain("/login chatgpt-subscription")
        expect(text).toContain("/login anthropic")
        expect(text).toContain("/login github-copilot")
        // `omo auth` has no sign-in subcommand: it prints or checks existing credentials only.
        expect(text).not.toContain("omo auth")
      })
    })
  })

  describe("#given an OAuth credential with no omo provider", () => {
    describe("#when the guidance renders", () => {
      test("#then it says so instead of naming a command that cannot work", () => {
        const text = guidance(["some-unknown-oauth"], [])

        expect(text).toContain("some-unknown-oauth")
        expect(text).not.toContain("/login some-unknown-oauth")
      })
    })
  })

  describe("#given an API key whose provider id matches no omo provider", () => {
    describe("#when the guidance renders", () => {
      test("#then it gives the reason and the next step", () => {
        const text = guidance([], ["unknown-gateway"])

        expect(text).toContain("unknown-gateway")
        expect(text).toContain("models.json")
        expect(text).toContain("/login")
      })
    })
  })

  describe("#given nothing was skipped", () => {
    describe("#when the guidance renders", () => {
      test("#then it is empty", () => {
        expect(guidance([], [])).toBe("")
      })
    })
  })
})

describe("omo setup provider map", () => {
  describe("#given the OpenCode provider ids seen in a real auth.json", () => {
    describe("#when they are resolved against the map", () => {
      test("#then every id that a builtin omo provider can serve resolves to it", () => {
        const resolve = (id: string): string | undefined =>
          (providerMap.builtinProviderIds as string[]).includes(id)
            ? id
            : (providerMap.providers as Record<string, string>)[id]

        // OpenCode Zen and Zen Go are builtin omo providers with the same endpoints
        // (https://opencode.ai/zen, https://opencode.ai/zen/go) and the same OPENCODE_API_KEY.
        expect(resolve("opencode")).toBe("opencode")
        expect(resolve("opencode-go")).toBe("opencode-go")
        // models.dev zai-coding-plan api == omo `zai` baseUrl (https://api.z.ai/api/coding/paas/v4).
        expect(resolve("zai-coding-plan")).toBe("zai")
        expect(resolve("kimi-for-coding")).toBe("kimi-coding")
        expect(resolve("unknown-gateway")).toBeUndefined()
      })
    })
  })
})
