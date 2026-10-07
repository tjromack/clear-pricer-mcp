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

## 2026-10-07 — Milestone 1: release layer, `compare_code_prices`, `release_info`

**What happened.** Built the verification chain (`src/release.ts`): pinned manifest hash → manifest → every file,
cached under the OS cache dir, written atomically, re-fetched if the cache is corrupted, refused if the source does
not match. DuckDB views are created lazily over verified files (`src/db.ts`), so the server starts instantly and only
downloads what a question touches. Provenance comes from the release's own `files` table. Two tools:
`compare_code_prices` and `release_info`.

**Results.**
- Offline suite: 27 tests (unit, contract, in-process MCP client), fixture-backed, 0.8 s.
- Release suite against `data-2026-10-07-67efd3d2`: 3 tests. `agg_code_prices` rows and proved key match
  `check_values.json` (49,404 / 49,404); 99213 matches the release row for row.
- Compiled `dist/` spawned over stdio by an SDK client (`npm run smoke`) answers both tools.
- Sanity mutation: rewriting the query to average across settings failed the grain test immediately.

**Decisions.** CPM-DEC 009 (`not_included` + notes instead of a silent partial answer; `setting` optional),
CPM-DEC 010 (fixtures are verified slices of the real release with their own pinned manifest).

**Learnings.**
- Northwestern publishes contracted dollars for only 1,699 of its 18,478 code-price rows; the rest are percentages or
  algorithms. None of the eight fixture codes has an NM dollar row. The "missing hospital" path is the common case,
  not an edge case, which is why it is structured output and not an error.
- No code string appears in two code families in this release; the guard stays because the table's key allows it.
- The SDK validates `structuredContent` against `outputSchema` on both sides (server always; client once it has
  listed tools), and skips validation on `isError` results, so throwing a descriptive error is the right
  fail-loudly mechanism.

**What broke.** A probe script "hung" for three minutes: it had never been written (the heredoc failed earlier in the
same command), so the run was a no-op waiting on a pipe. Lesson: check the file exists before diagnosing the tool.

**Next.** Confirm the tool set (CPM-DEC 006), then Milestone 2: `find_codes`, `get_payer_rates`, `lookup_provider`,
`data_quality`.
