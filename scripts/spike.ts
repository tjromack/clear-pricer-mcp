// Milestone 0 spike: can Node reach clear-pricer's pinned release through this machine's proxy?
// Throwaway — the findings move into src/release.ts and DECISIONS.md, then this file is deleted.
import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";

const TAG = "data-2026-10-07-67efd3d2";
const BASE = `https://github.com/tjromack/clear-pricer/releases/download/${TAG}`;

interface ManifestFile { file: string; rows: number; bytes: number; sha256: string }
interface Manifest { fingerprint: string; files: ManifestFile[]; check_values_sha256: string }

const sha256 = (buf: Uint8Array): string => createHash("sha256").update(buf).digest("hex");

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    console.error(`ok   ${label} (${Math.round(performance.now() - t0)} ms)`);
    return out;
  } catch (err) {
    console.error(`FAIL ${label}: ${err instanceof Error ? (err.cause ?? err.message) : String(err)}`);
    throw err;
  }
}

// 1. Node fetch through the proxy
const manifestBytes = await timed("fetch manifest.json", async () => {
  const res = await fetch(`${BASE}/manifest.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
});
console.error(`     manifest sha256 = ${sha256(manifestBytes)}`);
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;

// 2. Download one small file and verify it against the manifest; tampering must be detected
const small = manifest.files.find((f) => f.file === "rpt_npi_reconciliation.parquet");
if (!small) throw new Error("rpt_npi_reconciliation.parquet missing from manifest");
const smallBytes = await timed(`download ${small.file}`, async () => {
  const res = await fetch(`${BASE}/${small.file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
});
console.error(`     sha256 matches manifest: ${sha256(smallBytes) === small.sha256}`);
const tampered = smallBytes.slice();
tampered[100] = (tampered[100] ?? 0) ^ 0xff;
console.error(`     tampered copy detected:  ${sha256(tampered) !== small.sha256}`);

// 3. DuckDB (Node bindings) reading Parquet over HTTPS
const db = await DuckDBInstance.create(":memory:");
const conn = await db.connect();
const rows = await timed("duckdb remote agg_code_prices (99213, dollar)", async () => {
  const r = await conn.runAndReadAll(
    `SELECT hospital_id, setting, charge_rows, rate_min, rate_median, rate_max
       FROM '${BASE}/agg_code_prices.parquet'
      WHERE code = '99213' AND rate_basis = 'dollar'
      ORDER BY hospital_id, setting`,
  );
  return r.getRowObjectsJson();
});
console.table(rows);

// 4. Range read of the ~560 MB provider history for one NPI (sorted by NPI → few row groups)
for (const npi of ["1497859649", "1801771704"]) {
  const hist = await timed(`duckdb remote dim_provider_history npi=${npi}`, async () => {
    const r = await conn.runAndReadAll(
      `SELECT npi, version, org_name, status, valid_from, valid_to
         FROM '${BASE}/dim_provider_history.parquet' WHERE npi = '${npi}' ORDER BY version`,
    );
    return r.getRowObjectsJson();
  });
  console.table(hist);
}
