/**
 * Release-surface verifier for @formkit/tempo.
 *
 * Runs five gates in order and prints exactly one final verdict line:
 *   TEMPO-VERIFY: OK   (exit 0)
 *   TEMPO-VERIFY: FAIL (exit 1)
 *
 *   1. dependencies        pnpm install --frozen-lockfile; pnpm-lock.yaml and
 *                          package-lock.json must be byte-identical afterwards.
 *   2. reproducible-build  two consecutive `pnpm build` runs must produce a
 *                          byte-identical dist/ (every file, not just index).
 *   3. export-surface      dist/index.mjs, dist/index.cjs and dist/bundle.mjs
 *                          must export the exact runtime symbol set computed
 *                          from src/index.ts; dist/index.d.ts, dist/index.d.cts
 *                          and dist/bundle.d.ts must each declare exactly the
 *                          runtime set plus the pure-type set from src/types.ts.
 *   4. timezone-matrix     the full vitest suite runs once per entry in
 *                          scripts/verify/timezone-failures.json; each run must
 *                          prove its timezone, execute the same non-zero number
 *                          of tests, and fail exactly the registered tests.
 *   5. pack                `pnpm pack` output must contain every path named by
 *                          package.json (main/types/browser/unpkg/exports) and
 *                          pass publint; no tgz may be left in the repo.
 */
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-verify-"))
const startedAt = Date.now()

process.on("exit", () => {
  fs.rmSync(tmpdir, { recursive: true, force: true })
})

class GateFailure extends Error {}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function runOrFail(cmd, args, options = {}) {
  const result = run(cmd, args, options)
  if (result.status !== 0) {
    throw new GateFailure(
      `\`${cmd} ${args.join(" ")}\` exited with ${result.status}\n${result.stdout}${result.stderr}`.trim()
    )
  }
  return result
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function short(hash) {
  return hash.slice(0, 12)
}

function sortedSetDiff(expected, actual) {
  const want = [...expected].sort()
  const got = [...actual].sort()
  return {
    missing: want.filter((name) => !got.includes(name)),
    extra: got.filter((name) => !want.includes(name)),
  }
}

function formatSetDiff(label, { missing, extra }) {
  const parts = []
  if (missing.length) parts.push(`missing from ${label}: ${missing.join(", ")}`)
  if (extra.length) parts.push(`unexpected in ${label}: ${extra.join(", ")}`)
  return parts.join("\n")
}

/* ------------------------------ gate 1 ---------------------------------- */

function gateDependencies() {
  const tracked = ["pnpm-lock.yaml", "package-lock.json"]
  const before = tracked.map((file) => hashFile(path.join(root, file)))
  runOrFail("pnpm", ["install", "--frozen-lockfile"])
  const after = tracked.map((file) => hashFile(path.join(root, file)))
  for (let i = 0; i < tracked.length; i++) {
    if (before[i] !== after[i]) {
      throw new GateFailure(`${tracked[i]} changed during install`)
    }
  }
  return `lockfiles verified via \`pnpm install --frozen-lockfile\`, ${tracked.join(
    " + "
  )} byte-identical (sha256 ${short(sha256(after.join("")))}…)`
}

/* ------------------------------ gate 2 ---------------------------------- */

function distManifest() {
  const distDir = path.join(root, "dist")
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(distDir)
  files.sort()
  const lines = files.map(
    (file) => `${path.relative(distDir, file)}:${hashFile(file)}`
  )
  return { count: files.length, lines, digest: sha256(lines.join("\n")) }
}

function gateReproducibleBuild() {
  runOrFail("pnpm", ["build"])
  const first = distManifest()
  runOrFail("pnpm", ["build"])
  const second = distManifest()
  if (first.digest !== second.digest) {
    const changed = first.lines.filter((line, i) => line !== second.lines[i])
    throw new GateFailure(
      `dist/ is not reproducible between two consecutive builds:\n${changed.join("\n")}`
    )
  }
  return `2 consecutive builds, ${first.count} dist files byte-identical (dist sha256 ${short(
    first.digest
  )}…)`
}

/* ------------------------------ gate 3 ---------------------------------- */

function parseFile(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
}

function hasExportModifier(node) {
  return (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function resolveSibling(fromFile, specifier) {
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.d.ts`]) {
    if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return candidate
  }
  const asDeclaration = resolved.replace(/\.js$/, ".d.ts")
  if (fs.existsSync(asDeclaration)) return asDeclaration
  throw new GateFailure(`cannot resolve "${specifier}" from ${path.relative(root, fromFile)}`)
}

/** Collect runtime vs type-only exported names from a TypeScript source file. */
function collectSourceExports(file, runtime, types, seen = new Set()) {
  if (seen.has(file)) return
  seen.add(file)
  const sf = parseFile(file)
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          // `export { diff, type DiffOptions }` — only `diff` is runtime.
          if (st.isTypeOnly || el.isTypeOnly) types.add(el.name.text)
          else runtime.add(el.name.text)
        }
      } else if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        // `export * from "./types"` re-exports whatever the target has; a
        // type-only module like src/types.ts contributes zero runtime names.
        collectSourceExports(
          resolveSibling(file, st.moduleSpecifier.text),
          runtime,
          types,
          seen
        )
      }
    } else if (hasExportModifier(st)) {
      if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) {
        types.add(st.name.text)
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) runtime.add(decl.name.getText(sf))
      } else if (st.name) {
        runtime.add(st.name.text)
      }
    }
  }
}

/** Collect every exported name (runtime and type) from a declaration file. */
function collectDeclaredNames(file, names = new Set(), seen = new Set()) {
  if (seen.has(file)) return names
  seen.add(file)
  const sf = parseFile(file)
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add(el.name.text)
      } else if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        collectDeclaredNames(resolveSibling(file, st.moduleSpecifier.text), names, seen)
      }
    } else if (hasExportModifier(st)) {
      if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) names.add(decl.name.getText(sf))
      } else if (st.name) {
        names.add(st.name.text)
      }
    }
  }
  return names
}

async function gateExportSurface() {
  const runtime = new Set()
  const types = new Set()
  collectSourceExports(path.join(root, "src/index.ts"), runtime, types)
  if (runtime.size === 0 || types.size === 0) {
    throw new GateFailure("source surface resolved to an empty set — refusing to verify nothing")
  }

  const require = createRequire(path.join(root, "package.json"))
  const runtimeArtifacts = {
    "dist/index.mjs": Object.keys(await import(pathToFileURL(path.join(root, "dist/index.mjs")).href)),
    "dist/index.cjs": Object.keys(require("./dist/index.cjs")),
    "dist/bundle.mjs": Object.keys(await import(pathToFileURL(path.join(root, "dist/bundle.mjs")).href)),
  }
  const problems = []
  for (const [artifact, keys] of Object.entries(runtimeArtifacts)) {
    const diff = sortedSetDiff(runtime, keys)
    if (diff.missing.length || diff.extra.length) {
      problems.push(formatSetDiff(artifact, diff))
    }
  }

  const expectedDeclarations = new Set([...runtime, ...types])
  for (const artifact of ["dist/index.d.ts", "dist/index.d.cts", "dist/bundle.d.ts"]) {
    const declared = collectDeclaredNames(path.join(root, artifact))
    const diff = sortedSetDiff(expectedDeclarations, declared)
    if (diff.missing.length || diff.extra.length) {
      problems.push(formatSetDiff(artifact, diff))
    }
  }

  if (problems.length) throw new GateFailure(problems.join("\n"))
  return `${runtime.size} runtime + ${types.size} type names computed from src/index.ts + src/types.ts; ` +
    `index.mjs/index.cjs/bundle.mjs export exactly the runtime set; ` +
    `index.d.ts/index.d.cts/bundle.d.ts each declare exactly all ${runtime.size + types.size} names`
}

/* ------------------------------ gate 4 ---------------------------------- */

function gateTimezoneMatrix() {
  const registryPath = path.join(root, "scripts/verify/timezone-failures.json")
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
  const zones = Object.keys(registry.zones ?? {})
  if (zones.length === 0) {
    throw new GateFailure("timezone-failures.json registers no zones")
  }

  const lines = []
  let totalTests = null
  for (const zone of zones) {
    const env = { ...process.env, TZ: zone }
    // Evidence, from a fresh process with the exact env vitest will get, that
    // the requested timezone really resolves before the suite starts.
    const probe = runOrFail(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({resolved:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset(),tz:process.env.TZ}))",
      ],
      { env }
    )
    const evidence = JSON.parse(probe.stdout.trim())
    if (evidence.resolved !== zone || evidence.tz !== zone) {
      throw new GateFailure(
        `requested TZ=${zone} but the process resolved ${evidence.resolved} (TZ env=${evidence.tz})`
      )
    }

    const reportFile = path.join(tmpdir, `vitest-${zone.replaceAll("/", "_")}.json`)
    run("pnpm", ["exec", "vitest", "run", "--reporter=json", `--outputFile=${reportFile}`], { env })
    // Exit code alone is not a verdict — the JSON report is.
    if (!fs.existsSync(reportFile)) {
      throw new GateFailure(`vitest produced no JSON report for ${zone}`)
    }
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"))
    const executed = report.numTotalTests ?? 0
    if (executed === 0) {
      throw new GateFailure(`vitest executed 0 tests under ${zone}`)
    }
    if (totalTests === null) totalTests = executed
    else if (executed !== totalTests) {
      throw new GateFailure(
        `${zone} executed ${executed} tests, expected ${totalTests} (must be identical across zones)`
      )
    }

    const failed = []
    for (const file of report.testResults ?? []) {
      const rel = path.relative(root, file.name)
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === "failed") {
          failed.push(`${rel} > ${assertion.fullName || assertion.title}`)
        }
      }
    }
    failed.sort()
    const expected = [...(registry.zones[zone] ?? [])].sort()
    const diff = sortedSetDiff(expected, failed)
    if (diff.missing.length || diff.extra.length) {
      throw new GateFailure(
        `${zone} failures do not match scripts/verify/timezone-failures.json:\n` +
          [
            diff.missing.length && `registered but did not fail:\n  ${diff.missing.join("\n  ")}`,
            diff.extra.length && `failed but not registered:\n  ${diff.extra.join("\n  ")}`,
          ]
            .filter(Boolean)
            .join("\n")
      )
    }
    lines.push(
      `    ${zone}: resolved=${evidence.resolved} offset=${evidence.offset} — ${executed} tests, ${failed.length} failed (registry: ${expected.length})`
    )
  }
  return { summary: `${zones.length} zones × ${totalTests} tests, failures match the registry exactly`, lines }
}

/* ------------------------------ gate 5 ---------------------------------- */

function collectExportPaths(exportsField, paths = []) {
  if (typeof exportsField === "string") paths.push(exportsField)
  else if (exportsField && typeof exportsField === "object") {
    for (const value of Object.values(exportsField)) collectExportPaths(value, paths)
  }
  return paths
}

function gatePack() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  runOrFail("pnpm", ["pack", "--pack-destination", tmpdir])
  const tarballs = fs.readdirSync(tmpdir).filter((name) => name.endsWith(".tgz"))
  if (tarballs.length !== 1) {
    throw new GateFailure(`expected exactly one tgz in pack destination, found ${tarballs.length}`)
  }
  const listing = runOrFail("tar", ["-tzf", path.join(tmpdir, tarballs[0])]).stdout
    .trim()
    .split("\n")
  const entries = new Set(listing)

  const required = [pkg.main, pkg.types, pkg.browser, pkg.unpkg, ...collectExportPaths(pkg.exports)]
    .filter(Boolean)
    .map((p) => `package/${p.replace(/^\.\//, "")}`)
  const missing = [...new Set(required)].filter((p) => !entries.has(p))
  if (missing.length) {
    throw new GateFailure(`paths named in package.json missing from the tarball:\n  ${missing.join("\n  ")}`)
  }

  runOrFail("pnpm", ["exec", "publint"])

  const leftovers = fs.readdirSync(root).filter((name) => name.endsWith(".tgz"))
  if (leftovers.length) {
    throw new GateFailure(`tgz left behind in repo: ${leftovers.join(", ")}`)
  }
  return `${new Set(required).size}/${new Set(required).size} published paths present in ${tarballs[0]}; publint clean; no tgz left behind`
}

/* ------------------------------ runner ---------------------------------- */

const gates = [
  ["dependencies", gateDependencies],
  ["reproducible-build", gateReproducibleBuild],
  ["export-surface", gateExportSurface],
  ["timezone-matrix", gateTimezoneMatrix],
  ["pack", gatePack],
]

async function main() {
  for (let i = 0; i < gates.length; i++) {
    const [name, gate] = gates[i]
    try {
      const result = await gate()
      const summary = typeof result === "string" ? result : result.summary
      console.log(`[${i + 1}/${gates.length}] ${name}: OK — ${summary}`)
      if (typeof result !== "string" && result.lines) console.log(result.lines.join("\n"))
    } catch (error) {
      console.error(`[${i + 1}/${gates.length}] ${name}: FAIL`)
      console.error(error instanceof Error ? error.message : String(error))
      console.log("TEMPO-VERIFY: FAIL")
      process.exit(1)
    }
  }
  console.log(`TEMPO-VERIFY: OK (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
}

main()
