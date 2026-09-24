/**
 * JSON with comments and trailing commas, as OpenCode's `opencode.jsonc` writes it.
 *
 * Strict JSON is tried first, so a plain `opencode.json` never pays for the scan. The scan itself
 * is string-aware: a `//` inside a quoted value is data, not a comment.
 */

function strip(text) {
  let out = ""
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1
      out += text.slice(start, index + 1)
      index += 1
      continue
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    out += character
    index += 1
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

export function parseJsonc(text) {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(strip(text))
  }
}
