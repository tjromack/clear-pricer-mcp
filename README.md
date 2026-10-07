# clear-pricer-mcp

> © 2026 Trevor J. Romack — MIT-licensed · tjromack@gmail.com

**Ask what a procedure costs at three Chicago hospitals from any MCP client, and get back rows cited to the hospital's
own price file.**

A TypeScript MCP server over the public data release of
[clear-pricer](https://github.com/tjromack/clear-pricer): CMS-mandated hospital price files and the NPPES provider
registry, cleaned, reconciled and published as versioned Parquet. Every tool is read-only, typed end to end, and
returns provenance (hospital, source file, its SHA-256, its effective date, the release tag) with every row.

> **Public data only — no PHI, no keys, no accounts, no telemetry.**

**Demonstrates:** [TKTK — 20–120 chars naming the transferable how, e.g. "Exposing a versioned data release as typed,
grain-safe MCP tools, with contract tests pinned to the release's own check values."]

## Try it

```bash
claude mcp add clear-pricer -- npx -y clear-pricer-mcp
```

[TKTK — Claude Desktop / Cursor config snippet · one screenshot or GIF of a cited answer]

### Behind a corporate proxy

MCP clients start the server with a minimal environment. If your network inspects TLS, pass your CA to Node in the
server's config, e.g. for Claude Desktop:

```json
{ "mcpServers": { "clear-pricer": { "command": "npx", "args": ["-y", "clear-pricer-mcp"],
  "env": { "NODE_EXTRA_CA_CERTS": "C:\\path\\to\\corporate-ca.pem" } } } }
```

## Who it's for

[TKTK]

## Tools

[TKTK — table filled from DECISIONS.md CPM-DEC 006 once confirmed]

## How it's verified

[TKTK — contract tests per tool, pinned to `check_values.json` of release `data-2026-10-07-67efd3d2`; fail-loudly
tests; SHA-mismatch refusal; in-process client end-to-end run; recorded session. Real numbers only, once run.]

## What this does *not* let you claim

- Not a complete or authoritative price index: three Chicago hospitals, one pinned release. See clear-pricer's limits.
- Not a price estimate for any patient. Published negotiated rates are not what a given person pays.
- The NPPES provider history is read remotely by HTTP range, so its row count is checked against the manifest but
  it is not hash-verified like every other file (CPM-DEC 002, 013).
- [TKTK]

## Develop

```bash
git clone https://github.com/tjromack/clear-pricer-mcp && cd clear-pricer-mcp
npm ci && npm test        # offline, fixture-backed
npm run test:release      # downloads the pinned release and checks it against check_values.json
```
