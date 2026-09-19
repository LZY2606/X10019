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

Verify the release surface with a single command (finishes in well under 90
seconds, ends with `TEMPO-VERIFY: OK` or `TEMPO-VERIFY: FAIL`, and exits
non-zero on any failure):

```bash
pnpm verify
```

It runs five gates in order:

1. **deps** — installs with `pnpm install --frozen-lockfile` and requires
   `pnpm-lock.yaml` and the tracked `package-lock.json` to be byte-identical
   afterwards.
2. **build** — builds twice and requires every file in `dist/` to be
   byte-identical between the two runs, then prints the overall digest.
3. **exports** — derives the expected public API on the fly from
   `src/index.ts` (runtime symbols) and `src/types.ts` (pure types), then
   requires `dist/index.mjs`, `dist/index.cjs`, and `dist/bundle.mjs` to export
   exactly that runtime set, and `dist/index.d.ts`, `dist/index.d.cts`, and
   `dist/bundle.d.ts` to each cover both the runtime and the type names.
4. **tz-matrix** — runs the full vitest suite once each under
   `America/New_York`, `UTC`, and `Asia/Tokyo`, proving via in-process
   timezone evidence that each run really executed in the requested zone.
   Every run must execute the same non-zero number of tests, and the set of
   failing tests must match `scripts/verify/tz-known-failures.json` exactly —
   one failure more or less fails the gate.
5. **pack** — packs the tarball exactly as `files` in `package.json` dictates,
   requires every path referenced by `main`, `types`, `browser`, `unpkg`, and
   `exports` to be inside it, runs `publint`, and leaves no `.tgz` behind.

The timezone registry (`scripts/verify/tz-known-failures.json`) records the
known timezone-dependent failures — currently a fixed set inside
`addDay.spec.ts`, `diff.spec.ts`, `yearEnd.spec.ts`, and `yearStart.spec.ts`
that fails outside `America/New_York`. It describes existing behavior; never
edit tests to match it. Only the maintainer reviewing a change that
intentionally alters timezone behavior may update it: run
`TZ=<zone> npx vitest run --reporter=json` for the affected zone, hand-review
every newly failing or newly passing test, then regenerate that zone's list in
the same `<spec file> :: <test fullName>` format.

Build the docs app:

```bash
pnpm docs-build
```

<a href="https://tempo.formkit.com">
<img src="docs/public/read-the-docs.png" alt="Read the docs" width="200" height="43">
</a>

---

Created by the <a href="https://formkit.com">FormKit team</a>.
