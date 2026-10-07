# clear-pricer-mcp — decisions log

> Append-only. Point-in-time record of the calls made, so they are not re-litigated. Author: Trevor J. Romack.
> This is P2 of the portfolio slate — a TypeScript MCP server over clear-pricer's published data.

## CPM-DEC 001 — Its own repo, consuming the public release (2026-10-07)
**Status:** Decided.

- **What:** a separate repo (`C:/dev/mcp-clear-pricer`, remote `tjromack/clear-pricer-mcp`), not a folder inside
  clear-pricer.
- **Why:** the contract between the two is clear-pricer's public Parquet release, not shared code. Consuming it the
  way a stranger would proves the release is usable outside the warehouse it came from. P2 is a new card scored on
  §01 as a whole repo (own README, CI badge, try-it path), and clear-pricer's Python/dbt toolchain stays clean.
- **Rejected:** `clear-pricer/mcp/` subfolder — mixes toolchains, invites coupling to the gitignored local warehouse,
  and reads as an appendix rather than proof of MCP in TypeScript.
- **clear-pricer side:** one README link ("Use it from an MCP client"), nothing else.

## CPM-DEC 002 — Data source: the Parquet release via DuckDB (2026-10-07)
**Status:** Decided.

- **What:** `@duckdb/node-api` querying clear-pricer's GitHub Release Parquet.
- **Rejected:** the Supabase REST tier — 1,000-row page cap, no `fct_standard_charges` or `dim_provider_history`, and a
  hosted dependency that can sleep. Rejected "both" — twice the code paths for no new capability.
- **Download vs. remote (settled at Milestone 0, 2026-10-07):** every file except `dim_provider_history` is downloaded
  on first use to the OS cache and SHA-256-verified against the manifest before DuckDB opens it (the largest,
  `fct_standard_charges`, is 117 MB, a one-time cost). `dim_provider_history` (563 MB) is read by HTTP range over the
  pinned-tag URL: measured 476–648 ms per NPI lookup from this machine, because the file is sorted by NPI and a
  lookup touches a few row groups. Downloading 563 MB to answer one NPI question was rejected.
- **Limit this creates:** range reads cannot be SHA-verified. The tool checks the remote size against the manifest
  before querying and says in its provenance that the history was read remotely. Stated in the README limits.

## CPM-DEC 003 — Pinned release, SHA-verified (2026-10-07)
**Status:** Decided.

- **What:** default tag `data-2026-10-07-67efd3d2`; `CLEAR_PRICER_RELEASE` overrides. Every cached file is checked
  against that tag's `manifest.json`; a mismatch refuses to serve.
- **Why:** contract tests are pinned to that tag's `check_values.json`, so the answers are reproducible on request.
  `latest` would move the expected numbers under the tests every time clear-pricer cuts a release.
- **Bumping the pin** is a deliberate commit: update the default, re-run `npm run test:release`, note it here.

## CPM-DEC 004 — stdio transport only (2026-10-07)
**Status:** Decided.

- **Why:** works with Claude Code, Claude Desktop and Cursor; nothing hosted that can go to sleep before a monthly sweep.
- **Rejected for v1:** Streamable HTTP endpoint — needs a host and is one more thing to keep alive. Revisit if a demo
  needs a URL.

## CPM-DEC 005 — Try-it path: npm (2026-10-07)
**Status:** Decided.

- **What:** published as `clear-pricer-mcp` (unscoped; name free as of 2026-10-07). Card command:
  `claude mcp add clear-pricer -- npx -y clear-pricer-mcp`.
- **Needs:** `npm adduser` once (owner action), and an `NPM_TOKEN` repo secret for the publish workflow.

## CPM-DEC 006 — The v1 tool set (2026-10-07)
**Status:** Proposed — confirm at Milestone 1.

| Tool | Reads | Answers |
|---|---|---|
| `find_codes` | `agg_code_prices` (`code`, `code_family`, `example_description`) | "knee MRI" → candidate codes, using hospitals' own published descriptions |
| `compare_code_prices` | `agg_code_prices` + `files` | one code across hospitals, one `setting` × one `rate_basis` |
| `get_payer_rates` | `dim_charge_codes` → `fct_standard_charges` | one code at one hospital, by payer and plan, bounded |
| `lookup_provider` | `dim_provider_history` | an NPI as of a date (check digit validated first) |
| `data_quality` | `rpt_npi_reconciliation`, `rpt_source_conformance` | how much to trust a hospital's file |
| `release_info` | `manifest.json`, `check_values.json` | which release is served, and that it verified |

- **Why this set:** each tool maps to one grain in `docs/grain.md`, so no tool has to cross a grain boundary silently.
- **Not in v1:** FHIR reports (synthetic, not what a price question needs), `rpt_nppes_file_log`, free-form SQL.

## CPM-DEC 007 — The trust root is a hash in the source, not a URL (2026-10-07)
**Status:** Decided.

- **What:** `src/release.ts` pins the tag **and** the SHA-256 of that tag's `manifest.json`
  (`data-2026-10-07-67efd3d2` → `b46cbb9f98c0959b2a34d4852546a20e5baad6763f3acfa52e79174bed25ac04`). The manifest is
  verified first; every file is then verified against the manifest; `check_values.json` against
  `manifest.check_values_sha256`.
- **Why:** the manifest hashes every file but nothing hashes the manifest. Release assets can be replaced by the repo
  owner, so a tag URL alone is a mutable pointer. A hash committed here makes the whole chain checkable from the repo.
- **Rejected:** trusting the tag URL (mutable); signing (no key infrastructure for a public read-only dataset).

## CPM-DEC 008 — Lockfile written by npm 11; CI installs with npm 10 (2026-10-07)
**Status:** Decided.

- **What broke:** `npm install -D vitest@4` crashes npm 10.9.4 (`Cannot read properties of null (reading 'edgesOut')`
  in arborist `#loadPeerSet`), on a clean tree too. npm 11.21 resolves the same tree.
- **What:** add or upgrade dependencies with `npx npm@11 install …`; `npm ci` with npm 10 (what Node 20/22 runners
  ship) installs from that lockfile cleanly (verified). `vite` is a direct devDependency so vitest's peer is explicit.
- **Rejected:** `--legacy-peer-deps` (silently changes resolution for every future install); vitest 5 (drops Node 20).
