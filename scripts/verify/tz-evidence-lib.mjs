import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function recordTimezoneEvidence(scope) {
  const expected = process.env.VERIFY_TZ
  const dir = process.env.VERIFY_EVIDENCE_DIR
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  const record = {
    scope,
    pid: process.pid,
    envTZ: process.env.TZ ?? null,
    resolvedTZ: resolved,
    offsetMinutes: new Date().getTimezoneOffset(),
  }
  if (dir) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, scope + "-" + process.pid + ".json"),
      JSON.stringify(record, null, 2)
    )
  }
  if (expected && resolved !== expected) {
    throw new Error(
      "timezone evidence mismatch (" + scope + "): expected " + expected + ", resolved " + resolved
    )
  }
}
