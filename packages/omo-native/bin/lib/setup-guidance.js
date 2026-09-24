/**
 * What to tell the user about credentials setup found but could not copy.
 *
 * OAuth credentials are provider-bound tokens, so they are never copied; the user has to sign in
 * again. That sign-in lives in the interactive session (`/login <provider>`), NOT in `omo auth`,
 * which only prints or checks credentials that already exist.
 */

function oauthLoginTarget(provider, providerMap) {
  const mapped = providerMap.oauthLogins[provider]
  if (mapped) return mapped
  return providerMap.oauthProviderIds.includes(provider) ? provider : undefined
}

function oauthLines(providers, providerMap) {
  if (providers.length === 0) return []
  const lines = ["OAuth logins are not copied. Sign in again from inside omo:"]
  for (const provider of providers) {
    const target = oauthLoginTarget(provider, providerMap)
    lines.push(target
      ? `  ${provider}: run \`omo\`, then \`/login ${target}\``
      : `  ${provider}: omo has no provider for this login; keep using the other agent for it`)
  }
  return lines
}

function unmappedLines(providers) {
  if (providers.length === 0) return []
  return [
    "No omo provider serves these ids. Define the provider and its baseUrl in the engine's",
    "models.json, then run `omo`, `/login <provider>` and paste the key:",
    ...providers.map((provider) => `  ${provider}`),
  ]
}

export function formatCredentialGuidance(result, providerMap) {
  const lines = [
    ...oauthLines(result.skippedOauth, providerMap),
    ...unmappedLines(result.skippedUnmapped),
  ]
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}
