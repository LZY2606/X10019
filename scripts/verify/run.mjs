import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const root = fileURLToPath(new URL("../..", import.meta.url))
const verifyDir = join(root, "scripts", "verify")
const require = createRequire(join(root, "package.json"))

const TIMEOUT_MS = 90_000
const deadline = setTimeout(() => {
  console.log("TEMPO-VERIFY: FAIL (exceeded " + TIMEOUT_MS / 1000 + "s budget)")
  process.exit(1)
}, TIMEOUT_MS)

function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

function sha256File(path) {
  return sha256(readFileSync(path))
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function runOrFail(cmd, args, options = {}) {
  const result = run(cmd, args, options)
  if (result.status !== 0) {
    const tail = (result.stdout + "\n" + result.stderr).trim().split("\n").slice(-15).join("\n")
    throw new Error(cmd + " " + args.join(" ") + " exited " + result.status + "\n" + tail)
  }
  return result
}

function bin(name) {
  const ext = process.platform === "win32" ? ".cmd" : ""
  return join(root, "node_modules", ".bin", name + ext)
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function gateDeps() {
  const tracked = ["pnpm-lock.yaml", "package-lock.json"]
  const before = tracked.map((f) => sha256File(join(root, f)))
  runOrFail("pnpm", ["install", "--frozen-lockfile"])
  const after = tracked.map((f) => sha256File(join(root, f)))
  for (let i = 0; i < tracked.length; i++) {
    if (before[i] !== after[i]) {
      throw new Error(tracked[i] + " changed during install")
    }
  }
  return "frozen install; " + tracked.join(" + ") + " byte-identical"
}

function distManifest() {
  const files = walk(join(root, "dist")).sort()
  const lines = files.map(
    (f) => sha256File(f) + "  " + relative(join(root, "dist"), f).split(sep).join("/")
  )
  return { count: files.length, lines, digest: sha256(lines.join("\n")) }
}

function gateBuild() {
  runOrFail("pnpm", ["build"])
  const first = distManifest()
  runOrFail("pnpm", ["build"])
  const second = distManifest()
  if (first.lines.length !== second.lines.length || first.digest !== second.digest) {
    const a = new Set(first.lines)
    const b = new Set(second.lines)
    const diff = [...first.lines.filter((l) => !b.has(l)), ...second.lines.filter((l) => !a.has(l))]
    throw new Error("dist not reproducible:\n" + diff.slice(0, 10).join("\n"))
  }
  return second.count + " files byte-identical across 2 builds (sha256:" + second.digest.slice(0, 12) + ")"
}

function sourceExportNames() {
  const srcDir = join(root, "src")
  const indexSrc = readFileSync(join(srcDir, "index.ts"), "utf8")
  const runtime = new Set()
  const types = new Set()
  for (const m of indexSrc.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/g)) {
    for (let spec of m[1].split(",")) {
      spec = spec.trim()
      if (!spec) continue
      let target = runtime
      if (spec.startsWith("type ")) {
        target = types
        spec = spec.slice(5).trim()
      }
      const parts = spec.split(/\s+as\s+/)
      target.add(parts[parts.length - 1].trim())
    }
  }
  for (const m of indexSrc.matchAll(/export\s*\*\s*from\s*["']\.\/([^"']+)["']/g)) {
    const target = readFileSync(join(srcDir, m[1] + ".ts"), "utf8")
    for (const d of target.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      runtime.add(d[1])
    }
  }
  const typesSrc = readFileSync(join(srcDir, "types.ts"), "utf8")
  for (const d of typesSrc.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
    types.add(d[1])
  }
  return { runtime, types }
}

function declaredNames(file) {
  const text = readFileSync(file, "utf8")
  const names = new Set()
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/gs)) {
    for (let spec of m[1].split(",")) {
      spec = spec.trim()
      if (!spec) continue
      if (spec.startsWith("type ")) spec = spec.slice(5).trim()
      const parts = spec.split(/\s+as\s+/)
      names.add(parts[parts.length - 1].trim())
    }
  }
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:type|interface|const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  return names
}

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

async function gateExports() {
  const { runtime, types } = sourceExportNames()
  const expected = [...runtime].sort()
  const esm = Object.keys(await import(pathToFileURL(join(root, "dist", "index.mjs")))).sort()
  const bundle = Object.keys(await import(pathToFileURL(join(root, "dist", "bundle.mjs")))).sort()
  const cjs = Object.keys(require(join(root, "dist", "index.cjs"))).sort()
  const runtimeSet = new Set(runtime)
  for (const [label, keys] of [["dist/index.mjs", esm], ["dist/index.cjs", cjs], ["dist/bundle.mjs", bundle]]) {
    const missing = setDiff(runtimeSet, new Set(keys))
    const extra = setDiff(new Set(keys), runtimeSet)
    if (missing.length || extra.length) {
      throw new Error(
        label + " export mismatch" +
        (missing.length ? "; missing: " + missing.join(", ") : "") +
        (extra.length ? "; unexpected: " + extra.join(", ") : "")
      )
    }
  }
  const required = new Set([...runtime, ...types])
  for (const file of ["dist/index.d.ts", "dist/index.d.cts", "dist/bundle.d.ts"]) {
    const declared = declaredNames(join(root, file))
    const missing = setDiff(required, declared)
    if (missing.length) {
      throw new Error(file + " missing declarations: " + missing.join(", "))
    }
  }
  return expected.length + " runtime symbols identical in 3 bundles; 3 declaration files cover " +
    expected.length + " runtime + " + types.size + " type names"
}

const TZ_ZONES = ["America/New_York", "UTC", "Asia/Tokyo"]

function gateTimezone(tmp) {
  const registry = JSON.parse(readFileSync(join(verifyDir, "tz-known-failures.json"), "utf8"))
  for (const zone of TZ_ZONES) {
    if (!Array.isArray(registry[zone])) {
      throw new Error("tz-known-failures.json has no entry for " + zone)
    }
  }
  const lines = []
  const totals = []
  for (const zone of TZ_ZONES) {
    const slug = zone.replace(/\//g, "_")
    const evidenceDir = join(tmp, "tz-evidence-" + slug)
    const reportPath = join(tmp, "report-" + slug + ".json")
    run(bin("vitest"), [
      "run",
      "--config", join("scripts", "verify", "vitest.tz.config.mjs"),
      "--reporter=json",
      "--outputFile", reportPath,
    ], {
      env: {
        ...process.env,
        TZ: zone,
        VERIFY_TZ: zone,
        VERIFY_EVIDENCE_DIR: evidenceDir,
      },
    })
    if (!existsSync(reportPath)) {
      throw new Error(zone + ": vitest produced no JSON report (run aborted)")
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    if (!report.numTotalTests) {
      throw new Error(zone + ": 0 tests executed")
    }
    totals.push(report.numTotalTests)
    const failed = []
    for (const file of report.testResults) {
      const rel = relative(root, file.name).split(sep).join("/")
      for (const a of file.assertionResults ?? []) {
        if (a.status === "failed") failed.push(rel + " :: " + a.fullName)
      }
    }
    failed.sort()
    const expected = [...registry[zone]].sort()
    const unexpected = failed.filter((f) => !expected.includes(f))
    const missing = expected.filter((f) => !failed.includes(f))
    if (unexpected.length || missing.length) {
      throw new Error(
        zone + " failures diverge from tz-known-failures.json" +
        (unexpected.length ? "\n  not in registry:\n    " + unexpected.join("\n    ") : "") +
        (missing.length ? "\n  registered but passed:\n    " + missing.join("\n    ") : "")
      )
    }
    const evidenceFiles = existsSync(evidenceDir) ? readdirSync(evidenceDir) : []
    const mainEvidence = evidenceFiles.filter((f) => f.startsWith("main-"))
    const workerEvidence = evidenceFiles.filter((f) => f.startsWith("worker-"))
    if (!mainEvidence.length || !workerEvidence.length) {
      throw new Error(zone + ": missing timezone evidence (main or worker)")
    }
    for (const f of evidenceFiles) {
      const record = JSON.parse(readFileSync(join(evidenceDir, f), "utf8"))
      if (record.resolvedTZ !== zone || record.envTZ !== zone) {
        throw new Error(zone + ": evidence file " + f + " reports " + record.resolvedTZ)
      }
    }
    lines.push("    " + zone + ": " + report.numTotalTests + " tests, " + failed.length +
      " failed (registry: " + expected.length + "), TZ evidence verified")
  }
  if (new Set(totals).size !== 1) {
    throw new Error("test totals differ across timezones: " + totals.join(", "))
  }
  return { summary: "3 zones x " + totals[0] + " tests; failures match tz-known-failures.json", lines }
}

function collectExportPaths(value, out) {
  if (typeof value === "string") out.push(value)
  else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) collectExportPaths(value[key], out)
  }
  return out
}

function gatePack(tmp) {
  const pkg = require(join(root, "package.json"))
  const packDir = mkdtempSync(join(tmp, "pack-"))
  runOrFail("pnpm", ["pack", "--pack-destination", packDir])
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"))
  if (!tgz) throw new Error("pnpm pack produced no tarball")
  const listing = runOrFail("tar", ["-tzf", join(packDir, tgz)]).stdout
  const entries = new Set(listing.split("\n").map((l) => l.trim()).filter(Boolean))
  const required = [pkg.main, pkg.types, pkg.browser, pkg.unpkg, ...collectExportPaths(pkg.exports, [])]
    .filter(Boolean)
    .map((p) => "package/" + p.replace(/^\.\//, ""))
  const missing = required.filter((p) => !entries.has(p))
  if (missing.length) {
    throw new Error("tarball missing paths: " + missing.join(", "))
  }
  runOrFail(bin("publint"), [])
  return required.length + " entry paths present in tarball (" + entries.size + " files), publint clean"
}

function gitStatus() {
  return run("git", ["status", "--porcelain"]).stdout.trim()
}

function gateClean(before) {
  const after = gitStatus()
  if (after !== before) {
    throw new Error("working tree changed during verify:\n" + after)
  }
  return "git status clean"
}

const gates = [
  ["deps", gateDeps],
  ["build", gateBuild],
  ["exports", gateExports],
  ["tz-matrix", gateTimezone],
  ["pack", gatePack],
]

const tmp = mkdtempSync(join(tmpdir(), "tempo-verify-"))
const gitStatusBefore = gitStatus()
let failed = false
for (let i = 0; i < gates.length; i++) {
  const [name, fn] = gates[i]
  const label = "[" + (i + 1) + "/" + gates.length + "] " + name
  try {
    const result = await fn(tmp)
    if (result && typeof result === "object") {
      console.log(label + ": OK — " + result.summary)
      for (const line of result.lines) console.log(line)
    } else {
      console.log(label + ": OK — " + result)
    }
  } catch (err) {
    console.log(label + ": FAIL")
    console.log(String(err.message ?? err))
    failed = true
    break
  }
}
if (!failed) {
  try {
    gateClean(gitStatusBefore)
  } catch (err) {
    console.log("clean-tree: FAIL")
    console.log(String(err.message ?? err))
    failed = true
  }
}
rmSync(tmp, { recursive: true, force: true })
console.log(failed ? "TEMPO-VERIFY: FAIL" : "TEMPO-VERIFY: OK")
clearTimeout(deadline)
process.exit(failed ? 1 : 0)
