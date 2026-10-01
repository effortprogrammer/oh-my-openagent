export function rows(tx, args) {
  return tx.all(["id", "value"], `SELECT id, value FROM ${args.name}_items`, [], "id")
}

export function lateThrow() {
  setTimeout(() => { throw new Error("extension late throw") }, 0)
  return "scheduled"
}

export function lateRejection() {
  void Promise.reject(new Error("extension late rejection"))
  return "scheduled"
}

export async function failWhileActive(tx, args) {
  tx.exec(`INSERT INTO ${args.name}_items (id, value) VALUES (?, ?)`, [2, "must-roll-back"])
  // The resume timer is queued by the failing callback itself, so it always runs after the throw.
  await new Promise((resolve) => setTimeout(() => {
    setTimeout(resolve, 0)
    throw new Error("extension active late throw")
  }, 0))
  tx.exec(`INSERT INTO ${args.name}_items (id, value) VALUES (?, ?)`, [1, "must-roll-back"])
  return "written"
}
