# CLAUDE.md — Operating Contract

Working agreement for building **clear-pricer-mcp** with Claude Code. Read it before each session. The decisions this
contract assumes are recorded in `DECISIONS.md` (CPM-DEC 001–006) — read those first; do not re-open them.

## Purpose

A TypeScript MCP server that exposes **clear-pricer's published data release** as read-only tools any MCP client can
call. Ask what a procedure costs across the three Chicago hospitals in plain language and get cited rows back — every
number traceable to the hospital's own source file, its SHA-256, and its effective date.

This is **P2** of the portfolio slate. Its distinct job: prove MCP in the TypeScript ecosystem (MCP Suite is the Python
one), with **typed contract tests as the point**. It must read as different from MCP Suite: MCP Suite is retrieval over
a document store; this is a typed, grain-safe query surface over a versioned relational release.

## Design pins (do not violate without a DECISIONS entry)

1. **Strict TypeScript. No `any` in tool signatures** — inputs and outputs are zod schemas; tools return
   `structuredContent` validated against a declared `outputSchema`. `tsc --noEmit` with `strict` is a CI gate.
2. **Every response carries provenance:** hospital, source file name, source SHA-256, the hospital's
   `last_updated_on`, and the release tag. A row without provenance is a bug.
3. **Fail loudly, never empty.** A query that matches nothing returns an MCP tool error (`isError: true`) with an
   actionable message — what was searched, why nothing matched, and what to try (valid hospital ids, the settings and
   rate bases that *do* exist for that code). An empty array is never a success response.
4. **Read-only.** No tool writes anything except the local cache. All tools carry `readOnlyHint: true`.
5. **Grain-safe by construction** (from clear-pricer `docs/grain.md`):
   - Never add or average `rate_median` across `agg_code_prices` rows. A comparison is per hospital for **one**
     `setting` and **one** `rate_basis` (default `'dollar'`).
   - Charges → codes fans out 3.07×. Filter `dim_charge_codes` to the code *before* joining; count `distinct charge_id`.
   - `rpt_npi_reconciliation` carries an `ALL` row; never sum the table.
   - `dim_provider_history` intervals are half-open (`valid_from <= d < valid_to`, NULL = current).
6. **Pinned, verified data.** The server serves one pinned release tag (default in `src/release.ts`, overridable with
   `CLEAR_PRICER_RELEASE`). Every cached file is SHA-256-checked against that release's `manifest.json`; a mismatch
   refuses to serve, it does not warn.
7. **No keys, no accounts, no telemetry.** `npx -y clear-pricer-mcp` works cold. All data is public (CMS price files,
   NPPES) or synthetic; no PHI, and the README says so.
8. **Verification is part of the build.** Contract tests are pinned to the release's `check_values.json`. If a tool's
   contract test isn't written, the tool isn't done.

## Environment gotcha (banked)

This machine runs a **TLS-inspecting proxy**. DuckDB's own HTTPS reads work through it (verified 2026-10-07 from
Python); confirm the same for `@duckdb/node-api` and Node's `fetch` in Milestone 0. If Node `fetch` fails cert
verification, use `NODE_OPTIONS=--use-system-ca` (Node 22.15+), never `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Stack

- Node ≥ 20, ESM, **TypeScript strict**
- `@modelcontextprotocol/sdk` (1.x), stdio transport only (CPM-DEC 004)
- `zod` for every tool input/output schema
- `@duckdb/node-api` for querying the Parquet release
- `vitest` — unit, contract, and in-process client end-to-end tests (SDK `Client` + `InMemoryTransport`)
- `tsup` (or `tsc`) to build a single `bin` entry
- GitHub Actions: clean-clone CI on ubuntu + windows; publish to npm on tag

## Layout

```
src/
  index.ts          # bin entry: stdio transport, no logic
  server.ts         # registers tools; no SQL here
  release.ts        # pinned tag, manifest fetch, cache + SHA-256 verification
  db.ts             # DuckDB connection, views over cached/remote Parquet
  tools/<name>.ts   # one file per tool: zod in/out schema + handler + SQL
  provenance.ts     # shared provenance type and builder
  errors.ts         # actionable tool errors
tests/
  fixtures/         # tiny Parquet slices + a fixture manifest (public data, committed)
  unit/             # pure helpers (NPI check digit, error builders)
  contract/         # per-tool: schema, provenance, fail-loudly, grain guards
  release/          # against the real pinned release, asserted on check_values.json
  e2e/              # SDK Client over InMemoryTransport: list_tools, call each tool
```

## Conventions

- **Logs go to stderr only.** stdout is the MCP channel; one stray `console.log` corrupts the protocol.
- Tests run offline by default against `tests/fixtures/`. The `release` suite (network, ~120 MB) runs with
  `npm run test:release` and in CI with a cached download.
- SQL lives next to its tool, parameterised — never string-interpolated user input.
- The cache lives in the OS cache dir (`env-paths`), never in the repo. `.cache/` and `*.parquet` outside
  `tests/fixtures/` are gitignored.
- **Commit at each milestone boundary** with a readable message; the history is an interview artifact.
- Update `DECISIONS.md` (CPM-DEC n) on every non-trivial choice with the rejected alternative and the why.

## Session notes — the build journal (do this every session)

`docs/BUILD-LOG.md` is the dated journal. Each session appends (or updates today's) entry: **what happened · decisions
(→ also `DECISIONS.md`) · learnings · what broke and the fix · what's open/next.** It is the raw material for the case
study and is part of each milestone's definition of done.

## Definition of done (per milestone)

- The milestone's checklist in `TODO.md` is complete and its gate passes (and fails when it should).
- Demonstrable from a **clean clone**: `npm ci && npm test` with no keys and no network.
- New decisions recorded; a commit marks the boundary. **Stop and wait for approval before the next milestone.**

## Do not

- Do not return an empty result as success.
- Do not average or sum across grain (see pin 5).
- Do not add write tools, prompts that fabricate prices, or any non-public data.
- Do not bundle AMA CPT descriptors. Descriptions come only from what hospitals published in their own files.
- Do not ship a number you can't reproduce on request (portfolio hard rule).

## Case-study voice

State plainly what the system is, what it does, the decisions made, and what was learned. No disclaimers about the
author's experience; no honesty-signalling. Limits belong to the system, stated as scope or cost.
