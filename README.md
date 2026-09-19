<img src="docs/public/tempo.png" alt="TEMPO" width="500" height="195">

[![Vitest](https://github.com/formkit/tempo/actions/workflows/tests.yml/badge.svg)](https://github.com/formkit/tempo/actions/workflows/tests.yml)
![GitHub Sponsors](https://img.shields.io/github/sponsors/formkit)
![NPM Version](https://img.shields.io/npm/v/%40formkit%2Ftempo)

# Tempo — The easiest way to work with dates in JavaScript (and TypeScript)

Tempo is a new library in a proud tradition of JavaScript date and time libraries. Inspired by the likes of moment.js, day.js, and date-fns Tempo is built from the ground up to be as small and easy to use as possible.

Tempo is best thought of as a collection of utilities for working with `Date` objects — an important distinction from other libraries that provide custom date primitives. Under the hood, Tempo mines JavaScript's `Intl.DateTimeFormat` to extract complex data like timezones offsets and locale aware date formats giving you a simple API to format, parse, and manipulates dates.

Tempo is tiny tree-shakable framework, you can only take what you need. You can work with timezones with only a few bytes of library code, or perform full international date formatting for ~2Kb (minified and brotlied). [Size Limit](https://github.com/ai/size-limit) controls the size.

## Development

Install from the repository root with `pnpm`:

```bash
corepack enable
pnpm install
```

Build the library:

```bash
pnpm build
```

Build the docs app:

```bash
pnpm docs-build
```

Verify the release surface (dependencies, reproducible build, export surface,
timezone matrix, packaging) with a single command:

```bash
pnpm verify
```

It runs five gates in order and always ends with `TEMPO-VERIFY: OK` (exit 0) or
`TEMPO-VERIFY: FAIL` (exit 1):

1. **dependencies** — installs with `pnpm install --frozen-lockfile` and
   asserts `pnpm-lock.yaml` and `package-lock.json` are byte-identical before
   and after, so the lockfiles are validated, never rewritten.
2. **reproducible-build** — builds twice in a row and requires every file in
   `dist/` to be byte-identical between the two runs, then prints the overall
   digest.
3. **export-surface** — recomputes the public API on every run from
   `src/index.ts` (runtime symbols; `type` modifiers and `export * from
   "./types"` contribute none) and `src/types.ts` (pure types), then requires
   `dist/index.mjs`, `dist/index.cjs` and `dist/bundle.mjs` to export exactly
   the runtime set, and `dist/index.d.ts`, `dist/index.d.cts` and
   `dist/bundle.d.ts` to each declare exactly the runtime set plus the types.
4. **timezone-matrix** — runs the full vitest suite once per zone listed in
   `scripts/verify/timezone-failures.json` (`America/New_York`, `UTC`,
   `Asia/Tokyo`). Each run must prove its timezone resolved correctly, execute
   the same non-zero number of tests, and fail exactly the tests registered
   for that zone — no more, no fewer. `America/New_York` must stay fully green.
5. **pack** — packs the tarball per `package.json` `files`, requires every
   path named by `main`, `types`, `browser`, `unpkg` and `exports` to be
   inside it, runs `publint`, and leaves no tgz behind.

The timezone registry in `scripts/verify/timezone-failures.json` records
observed facts, not goals. It may only be changed by a maintainer who has
re-run the suite under the affected timezone and reviewed every added or
removed entry in the commit that changes it — never edit tests or assertions
to fit the registry, and never register a failure outside `addDay.spec.ts`,
`diff.spec.ts`, `yearEnd.spec.ts` or `yearStart.spec.ts` without a documented
reason. The `America/New_York` list must always stay empty.

<a href="https://tempo.formkit.com">
<img src="docs/public/read-the-docs.png" alt="Read the docs" width="200" height="43">
</a>

---

Created by the <a href="https://formkit.com">FormKit team</a>.
