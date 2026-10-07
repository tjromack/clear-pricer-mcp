# Build log — clear-pricer-mcp

Dated journal of the build: what happened, decisions, learnings, what broke, what's next. Raw material for the case
study.

## 2026-10-07 — Kickoff, Phase 0, Milestone 0

**What happened.** Chose a separate repo over a folder in clear-pricer (CPM-DEC 001): the contract between the two is
clear-pricer's public Parquet release, so this server consumes it the way a stranger would. Settled data source
(Parquet via DuckDB), a pinned SHA-verified release, stdio only, npm as the try-it path (CPM-DEC 002–005). Scaffolded
strict TypeScript, then spiked the data path and a walking-skeleton server.

**Milestone 0 results (this machine, behind the TLS-inspecting proxy):**
- Node `fetch` of `manifest.json`: 154 ms. No proxy workaround needed for Node 22.
- `rpt_npi_reconciliation.parquet` downloaded and SHA-256 matched the manifest; a one-byte-flipped copy failed.
- `@duckdb/node-api` remote query over `agg_code_prices` for 99213: 580 ms.
- `dim_provider_history` (563 MB) one-NPI lookup by HTTP range: 476–648 ms. Settles CPM-DEC 002: read it remotely,
  download everything else.
- An SDK `Client` spawning the server over stdio (from source and from compiled `dist/`) listed the tool and got real
  rows back; a malformed code was refused by the input schema with `isError: true`.

**Decisions.** CPM-DEC 007: the trust root is the manifest's SHA-256 pinned in source, because nothing in the release
hashes the manifest and a tag URL is a mutable pointer. CPM-DEC 008: lockfile written by npm 11.

**What broke.** `npm install -D vitest@4` crashed npm 10.9.4 inside arborist's peer-set loader (`edgesOut` of null),
even on a clean tree. Bisected to vitest; npm 11.21 resolves the same tree, and npm 10's `npm ci` installs from the
resulting lockfile, so CI on Node 20/22 is unaffected.

**Learnings.**
- 99213 has **no** contracted-dollar row at Northwestern, only Rush and UChicago. The first real query is a partial
  match, which is exactly the case `compare_code_prices` must explain (which hospitals and bases *do* exist) rather
  than silently returning two of three.
- DuckDB's Node API returns BIGINT as JSON strings (`"30"`); output schemas convert explicitly, never via `any`.
- A zero-length history version (`1801771704` v1, `valid_from = valid_to`) came back in the raw lookup; the as-of tool
  must never answer with it (half-open intervals).

**Next.** Milestone 1: `release.ts` (pinned manifest hash → files → cache), provenance and error builders,
`compare_code_prices` and `release_info` with contract tests on fixtures and an in-process e2e.
