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

**Learnings.** CMP-1 (averaging across settings) was caught by exactly one test: killed, but the most important
grain rule rested on a single assertion. Added an independent test (every fixture code × two rate bases, row for row
against the raw table); CMP-1 is now caught by two. 88 tests total.

**Next.** Milestone 4: CI on ubuntu + windows, npm publish workflow, README with real numbers, recorded session,
§01 scoring.

## 2026-10-07 — Milestone 4: CI, publishing, README, scorecard

**What happened.** CI (`ci.yml`): clean clone on Ubuntu and Windows × Node 20 and 22 (typecheck, offline tests,
build), plus a release job that downloads the pinned release into a cached directory, runs the release suite, and
drives the compiled server over stdio. Publish workflow (`publish.yml`) on `v*` tags: the same gates, `npm publish
--provenance`, then the card's exact `npx -y clear-pricer-mcp` command run from the registry on clean Ubuntu and
Windows runners. README rewritten with the real numbers; `docs/DEMO.md` scripts the recording; `docs/SCORECARD.md`
scores §01 at 14/16 now and 16/16 after publish and the GIF.

**Results.** First CI run green on all five jobs (37–57 s each; the release job downloaded the release on a fresh
runner in 41 s total). A local clean clone: `npm ci`, typecheck, 66 offline tests, build. Packed tarball: 29 files,
33.6 kB; installed from the tarball it starts and answers `initialize`.

**What broke.**
- `npx -y ./clear-pricer-mcp-0.1.0.tgz` exits without running anything: with a tarball *path*, npx does not resolve
  the bin. `npx --yes --package <tgz> clear-pricer-mcp` works, and from the registry the bare name resolves by package
  name; the publish workflow tests exactly that on clean runners.
- GitHub warned that `actions/checkout@v4` / `setup-node@v4` run on deprecated Node 20; moved to v7 / v7 and
  `actions/cache@v6`.
- Source maps pointed at `src/`, which is not shipped; turned off in the build.

**Learnings.** clear-pricer's own `docs/grain.md` as-of example (NPI 1497859649 on 2026-06-30) returns 0 rows against
the current release: that NPI's history starts 2026-07-16. `lookup_provider` answers it with the valid range instead
of nothing, which is the behaviour this server is built for; the example in clear-pricer should move to a date inside
the history.

**Open (owner).** npm account + `NPM_TOKEN`, tag `v0.1.0`; record the session; make the repo public; push
clear-pricer's link commit.

## 2026-10-07 — Published: `clear-pricer-mcp@0.1.0`

**What happened.** Tagged `v0.1.0`. The publish workflow passed every gate, then npm refused the upload: provenance
is only accepted from a public repository (`422 … Unsupported GitHub Actions source repository visibility:
private`). The repo was made public and the failed jobs re-run; the package published with a signed provenance
statement. The post-publish `npx` check then failed with `clear-pricer-mcp: not found`.

**What broke.** The check ran `npx clear-pricer-mcp` inside the repo checkout, whose `package.json` has the same
name, so npx resolved the local project (no bin installed) instead of the registry. The published package was fine:
run from a neutral directory against the registry it started and answered. The smoke client now takes `SMOKE_CWD`,
and a new `npx-check.yml` runs the card's command from the registry on clean Ubuntu and Windows runners, on demand
and weekly; first run green on both.

**Learnings.** A test of "what a stranger runs" has to run where a stranger is. Both failures here were in the
checks, not the package, and both were only visible because the checks ran against the real registry.

**Score.** §01 at 15/16; the recorded session GIF is the last point.

## 2026-10-08 — Recorded session; §01 at 16/16

**What happened.** Connected the published server to the Claude Code VS Code extension (`claude mcp add --scope user`
with `NODE_EXTRA_CA_CERTS` passed through, via the extension's bundled `claude.exe`, since no `claude` command is on
PATH), recorded the five-question session from `docs/DEMO.md`, and added it to the README as `docs/demo.gif`
(7.1 MB). §01 is now 16/16.

**What broke.** Two small ones, both outside the code. Windows PowerShell 5.1 drops a bare `--` before passing it to a
native program, so `claude mcp add … -- npx …` has to quote it (`'--'`). And the GIF arrived as `demo.gif.gif`
(Explorer hides known extensions); renamed.

**Also fixed (in clear-pricer).** The as-of example in `docs/grain.md` and `docs/QUERY.md` used 2026-06-30, before
that NPI's history begins (2026-07-16), so it returned 0 rows. Moved to 2026-10-01.

**Next.** The case study, due within two weeks of the 2026-10-07 ship; then the site card.

## 2026-10-08 — Case study, and the site handoff

**What happened.** Wrote the case study (`docs/CASE-STUDY.md`) and a version for the site's `projects` collection,
with the /builds card as a `buildOverrides` entry. The site plays screen recordings as MP4 with a poster, not GIF, so
the recording was converted (932×682, 5.7 MB) and its poster taken from the 99213 answer. The handoff was applied to
a throwaway clone of the site, and the site's own gates passed: `seo-check` across 19 pages, and `figure-check`
confirming every pill figure appears in the case study.

**Learnings.** The recording caught a model using the fail-loudly design as an interface. Asked for Northwestern's
rates by payer, it sent a filter it expected to match nothing, read the list of 15 payers out of the error, and
fetched them one at a time by name so no rows were cut off. The error was written to explain a dead end; the model
used it as an index.

**Found in passing.** The site's `astro check` reports 3 pre-existing errors in `src/lib/lens-style.ts`: three style
maps lack the `forward-deployed` lens. Noted in the handoff; not this project's to fix.
