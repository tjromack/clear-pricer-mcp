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

## 2026-10-07 — Milestone 2: `find_codes`, `get_payer_rates`, `lookup_provider`, `data_quality`

**What happened.** Tool set confirmed (CPM-DEC 006). Moved the release's closed vocabularies (hospitals, settings,
rate bases, code families) into `src/vocab.ts` as input enums, with a release test proving each equals the release's
distinct values. Built the four tools; extended the fixtures to every table the tools read (4,781 charges, 1,745 code
rows, 19 provider versions chosen case by case).

**Results.**
- Offline: 64 tests. Release: 11 tests against `data-2026-10-07-67efd3d2`. All six tools answer over stdio from the
  compiled build.
- `get_payer_rates`' charge selection reproduces every one of the 49,404 `agg_code_prices.charge_rows`: 0
  mismatches. The fixtures fan out 3.6× if charges are joined to codes naively (4,781 → 17,094); the tool never does.
- `data_quality`'s overall row equals `check_values.json`'s published headline (unresolved 0.0%, coverage 13.3%).

**What broke.**
1. **MS-DRGs returned no charges.** `dim_charge_codes.code_family` is NULL on MS-DRG rows; clear-pricer's
   `agg_code_prices` derives the family as `coalesce(code_family, declared_type)`. The per-code cross-check test
   failed on 470 at all three hospitals; the fix copies clear-pricer's definition exactly, and the whole-release check
   now guards it (CPM-DEC 011). The fixture generator had the same bug, which is why 470 had no fixture charges.
2. **`lookup_provider` failed every time over stdio, never in tests.** "fetch failed", then, once the error message
   carried the cause, "unable to verify the first certificate". The SDK's stdio client passes the server only a
   whitelist of env vars, dropping the `NODE_EXTRA_CA_CERTS` this machine sets for its TLS-inspecting proxy; vitest
   ran the server in-process with the full environment, so it never saw the problem. Moved the remote-file check
   into DuckDB (Parquet footer row count; DuckDB trusts the proxy on its own) and made download errors name the fix
   (CPM-DEC 013). The first fix, retries, would not have helped; the useful one was making the error say why.
3. `column` is a reserved word in DuckDB SQL: it broke the fixture generator and `data_quality`'s `ORDER BY`.

**Learnings (about the source data).**
- UChicago's file describes CPT 44373 (small-bowel endoscopy) as a functional brain MRI, so a description search for
  "mri brain" returns it. `find_codes` now marks which hospitals' descriptions matched and notes single-hospital
  matches (CPM-DEC 012).
- Rush's file publishes some charges twice at different positions (99213 / Aetna at `r58344` and `r61146`). Kept as
  published, each cited by position, with a note.

**Next.** Milestone 3: per-tool mutation suite (grain violations each must fail), results published in
`docs/results/contract-tests.md`.

## 2026-10-07 — Milestone 3: verification against the release, and a mutation suite

**What happened.** Added release tests that recompute the downloaded release against its own `check_values.json` at
full scale, and a mutation suite: 24 hand-written bugs, each applied, type-checked, run against every suite, and
restored, with the results page generated from the run (`npm run mutate` → `docs/results/contract-tests.md`).

**Results.**
- 87 tests: 17 unit, 45 contract, 3 e2e, 22 release. The release suite runs in about 3 s once the files are cached.
- At full scale: 7,371,416 charges join to 22,647,893 code rows (3.0724×, the published fan-out); the tools'
  semi-join covers exactly the 5,704,751 charges `agg_code_prices` covers; integer-cent checksums of
  `negotiated_rate` and `gross_charge` match; every downloaded table matches its row count and proved key.
- Mutations: 24 of 24 killed.

**What broke (in the tests, which is the point).**
- First run: 21 killed, 1 survived, 2 invalid. The survivor, PAY-6 (payer filter leaking into the per-setting
  breakdown), had no test even though the output schema documents the behaviour. Added one.
- NPI-3 as planned ("latest version starting on or before the date") is an equivalent mutant: the history has no
  gaps between versions, so it cannot be wrong on this data. Replaced with "ignores as_of", reason recorded.
- REL-3 and NPI-3 initially failed to type-check (`findLast` is ES2023; the target is ES2022). The runner reports
  those as invalid rather than killed, which is what kept them from inflating the score.

**Learnings.** CMP-1 (averaging across settings) is caught by exactly one test. Killed, but thin: the most
important grain rule in the project rests on a single assertion. Worth a second, independent test in a later pass.

**Next.** Milestone 4: CI on ubuntu + windows, npm publish workflow, README with real numbers, recorded session,
§01 scoring.
