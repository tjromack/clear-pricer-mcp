# clear-pricer-mcp — case study

**A TypeScript MCP server that lets an AI assistant answer hospital price questions from clear-pricer's release, every
row cited to the hospital's own file.** Built by Trevor J. Romack, 2026. Code:
[github.com/tjromack/clear-pricer-mcp](https://github.com/tjromack/clear-pricer-mcp) · Package:
[clear-pricer-mcp on npm](https://www.npmjs.com/package/clear-pricer-mcp)

---


## Overview

[clear-pricer](https://github.com/tjromack/clear-pricer/blob/main/docs/CASE-STUDY.md) publishes a cleaned, versioned release of three Chicago hospitals' price files and
the NPPES provider registry. `clear-pricer-mcp` puts that release inside any MCP client as six read-only tools. Ask
what an office visit costs at each hospital, and the answer comes back as rows, each one naming the hospital's source
file, that file's SHA-256 and effective date, and the release it came from.

It is one command to try, with no account and no key:

```bash
claude mcp add clear-pricer -- npx -y clear-pricer-mcp
```

![Claude Code asking five questions through clear-pricer-mcp, with cited rows](demo.gif)

## The problem

An assistant with access to price data will answer price questions fluently whether or not the answer is right. The
data makes wrong answers easy.

Northwestern publishes contracted dollar amounts for 1,699 of its 18,478 code-price rows, about 9%. The rest are
percentages of its own list price or formulas. Ask for the contracted price of an established-patient office visit
(CPT 99213) and the correct result is two hospitals, not three. A tool that returns those two rows without comment
lets the assistant present a two-hospital comparison as a three-hospital one.

The release's grain makes it worse. A charge is listed once per code its item carries, so joining charges to codes
turns 7,371,416 charges into 22,647,893 rows, 3.07 times as many. The price summary is per hospital, code, setting and
rate basis, so averaging its medians mixes inpatient with outpatient and contracted dollars with percentages. Every
one of those mistakes produces a confident, well-formed number.

So the job was not "expose the tables". It was to make the tools unable to give a wrong answer quietly.

## Constraints

**Every row carries its source.** Hospital, source file, the file's SHA-256, its effective date and the release tag.
A row without provenance is a bug, not a style choice.

**Fail loudly, never empty.** A question nothing in the release can answer returns an error saying what was searched,
why nothing matched, and what does exist. An empty list is never a success.

**Nothing unverified reaches a query.** The release is pinned, and every file is checked against it before DuckDB
opens it.

**Read-only, no keys, no telemetry.** `npx -y clear-pricer-mcp` has to work cold on a stranger's machine.

**Typed end to end.** Inputs and outputs are zod schemas; every tool returns structured content the client can
validate. Strict TypeScript, no `any` in a tool signature.

## Architecture

```
pin            src/release.ts: tag + SHA-256 of that release's manifest.json
verify         manifest against the pin, then each file against the manifest
cache          OS cache dir; atomic writes; a corrupted entry is re-fetched, a mismatch refuses to serve
duckdb         lazy views: a table is downloaded only when a question first needs it
remote         the 563 MB provider history is range-read; its row count is checked from the Parquet footer
tools          find_codes · compare_code_prices · get_payer_rates · lookup_provider · data_quality · release_info
transport      stdio, any MCP client
```

| Tool | Answers |
|---|---|
| `find_codes` | Plain words to billing codes, from the hospitals' own descriptions; flags codes that matched on one hospital's wording only |
| `compare_code_prices` | One code across hospitals for one rate basis; names the hospitals that publish it another way, and how |
| `get_payer_rates` | One code at one hospital by payer and plan, each charge cited by its position in the source file |
| `lookup_provider` | Who an NPI was on a date, every version on record, and which hospital discloses it |
| `data_quality` | NPI reconciliation, template deviations and quarantined rows per hospital |
| `release_info` | Which release is served, what it was built from, and each file's verification status |

## Key decisions

All fourteen are in [`DECISIONS.md`](https://github.com/tjromack/clear-pricer-mcp/blob/main/DECISIONS.md) with the
rejected alternative beside each. The ones that shaped the rest:

**Chose a separate repo consuming the public release over a folder inside clear-pricer.** Because the contract
between the two is the published Parquet, and reading it the way a stranger would proves the release is usable
outside the warehouse that built it. The cost is a second CI and a version pin to bump when clear-pricer cuts a
release.

**Chose a hash in the source as the trust root over trusting the release URL.** Because the release manifest hashes
every file but nothing hashes the manifest, and a release asset can be replaced. The cost is that a new release
needs a commit, not just a new tag.

**Chose naming the missing hospital over returning only what matched.** `compare_code_prices` defaults to contracted
dollars and lists every hospital it left out with what that hospital does publish for the code. Because at
Northwestern the missing case is the common case. The cost is a longer answer every time.

**Chose a hand-written mutation catalogue over a generic mutation tool.** Because the failures that matter here are
grain failures (a fanned-out join, an average across settings, a closed date interval), and a generic tool produces
thousands of syntactic mutants that mostly test nothing this project is about. The cost is that the catalogue is
only as good as the bugs I thought to plant.

**Chose reading the provider history remotely over downloading it.** Because the file is sorted by NPI, one lookup
reads a few row groups: a lookup took 476 to 648 ms, against downloading 563 MB first. The cost is that a range read cannot be
hash-verified, so the history is checked by row count and the README says so.

## How it's verified

| Check | Result |
|---|---|
| Tests | 88: 17 unit, 46 contract (each tool through a real MCP client), 3 end-to-end, 22 against the real release |
| Planted bugs | 24 of 24 caught by at least one test ([results](https://github.com/tjromack/clear-pricer-mcp/blob/main/docs/results/contract-tests.md), generated by the run) |
| Charge selection | Reproduces all 49,404 `charge_rows` in the price summary, 0 mismatches; covers exactly its 5,704,751 charges |
| Fan-out | 7,371,416 charges join to 22,647,893 code rows (3.07×), as the release publishes; the tools never return the joined rows |
| Integrity | Tampered file, corrupted cache, wrong pin and a footer row count that disagrees with the manifest: each refused, each tested |
| Money | Integer-cent checksums of the negotiated rate and gross charge columns match the release |
| Clean clone | CI on Ubuntu and Windows, Node 20 and 22; the compiled server driven over stdio by an MCP client |
| Try-it path | The published package run by `npx` from npm on clean Ubuntu and Windows runners, weekly |

The mutation suite is the part worth describing. `npm run mutate` applies each planted bug as an exact source edit,
requires it to compile (a bug that does not compile proves nothing, and is reported as invalid rather than caught),
runs every suite, records which tests failed, and restores the file. The first run caught 21. One survived: the payer
filter leaking into a per-setting breakdown that the output schema promised was unfiltered. No test checked the
promise; one does now. One planned bug turned out to be harmless on this data, since the provider history has no gaps
between versions, so "latest version on or before the date" is always the right version. It was replaced, and the
reason is recorded in the catalogue. The rule against averaging across settings was caught by exactly one test, so a
second, independent test was added.

## What broke

**MS-DRGs found no charges.** `get_payer_rates` returned nothing for DRG 470 at all three hospitals. In the code
table, MS-DRG rows have a null code family; clear-pricer's price summary derives it from the declared type instead.
The fix copies clear-pricer's definition exactly, and a release test now applies it to every hospital and code at
once and requires all 49,404 summary rows to be reproduced. Before the fix, the 5,594 MS-DRG rows would have failed
it. The test-data generator had the same bug, which is why the fixtures had no DRG charges to catch it sooner.

**A tool that only failed outside the tests.** Over stdio, `lookup_provider` failed every time with "fetch failed";
in the test suite it never did. Once the error carried its cause, it read "unable to verify the first certificate".
MCP clients start a server with a short whitelist of environment variables, which drops the variable this machine
uses to trust its TLS-inspecting proxy; the tests ran the server in-process, with the full environment. The remote
check moved into DuckDB, which already trusted the proxy, and a certificate error now names the setting to add. The
first fix attempted, retries, would not have helped. The useful one was making the error say why.

**The source data, as published.** UChicago's file describes CPT 44373, a small-bowel endoscopy, as a functional
brain MRI, so a search for "mri brain" returns it. Rush's file lists some charges twice at different positions. The
tools keep both as published: `find_codes` marks which hospitals' descriptions matched and notes a single-hospital
match, and `get_payer_rates` cites each repeated charge by its own position in the file.

**Publishing.** npm refused the first upload: signed provenance is only accepted from a public repository. Once
published, the check that runs the card's `npx` command failed with "not found". It had run inside the repo, whose
`package.json` has the same name, so `npx` looked for the local project instead of the registry. The package was
fine; the check now runs from a neutral directory, where a stranger would be.

The recording shows one more thing the tests never asked for. Asked for Northwestern's rates by payer, the assistant
sent a payer filter it expected to match nothing, read the list of all 15 payers out of the error, then fetched
payers one at a time by name so no rows were cut off. The error was written to explain a dead end; the model used it
as an index.

## What I'd do differently

Drive the server over real stdio from the first test, not only in-process: the environment-stripping failure was
invisible until something spawned the server the way a client does. And write each tool's planted bugs alongside the
tool, so the survivor the first mutation run found never exists.

## Limits

**Three hospitals, one pinned release.** Exactly what [clear-pricer](https://github.com/tjromack/clear-pricer/blob/main/docs/CASE-STUDY.md) publishes, including its
stated limits. A new clear-pricer release reaches this server only when the pin is moved and the release tests pass
against it.

**Not a patient's price.** Published negotiated rates are contract terms, not what any given person pays.

**Descriptions are the hospitals' own.** They can be wrong, as 44373 shows. The tools surface disagreements; they do
not correct them.

**The provider history is not hash-verified.** It is range-read, so its row count is checked against the manifest
and every other file is hashed.

**Local only.** stdio, on the user's machine. The first payer-rate question downloads the 117 MB charge table once.

## Links

The package is
[clear-pricer-mcp on npm](https://www.npmjs.com/package/clear-pricer-mcp), published with provenance. The mutation
results are in [`docs/results/contract-tests.md`](https://github.com/tjromack/clear-pricer-mcp/blob/main/docs/results/contract-tests.md),
regenerated by `npm run mutate`. [`DECISIONS.md`](https://github.com/tjromack/clear-pricer-mcp/blob/main/DECISIONS.md)
carries the fourteen decisions with their rejected alternatives, and
[`docs/BUILD-LOG.md`](https://github.com/tjromack/clear-pricer-mcp/blob/main/docs/BUILD-LOG.md) records each break
as it happened.
