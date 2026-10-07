// Builds tests/fixtures/release/: small slices of the real pinned release, with their own manifest, check values and
// pin, so the offline tests exercise the same verification chain as production. Run: npm run fixtures
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Db, int, type TableName } from "../src/db.js";
import { DEFAULT_PIN, Release, defaultCacheDir, githubSource, sha256 } from "../src/release.js";

const OUT = join(import.meta.dirname, "..", "tests", "fixtures", "release");

/** Each code earns its place by the case it exercises. */
export const FIXTURE_CODES = {
  "99213": "all three hospitals; NM publishes no contracted dollar rate, only percent-derived and algorithm rows",
  "99214": "all three hospitals, outpatient and both settings",
  "70553": "MRI brain: description search (find_codes)",
  "73721": "MRI lower-extremity joint: description search (find_codes)",
  J1885: "HCPCS drug code",
  "470": "MS-DRG, inpatient only",
  "10011": "published by UChicago only",
  "12002": "the 'both' setting at Rush and UChicago",
} as const;

const release = new Release(DEFAULT_PIN, githubSource(DEFAULT_PIN.tag), defaultCacheDir());
const db = await Db.open(release);
const real = await release.manifest();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const codes = Object.keys(FIXTURE_CODES).map((c) => `'${c}'`).join(", ");
/** NPIs chosen for the case each exercises; plus the hospitals' disclosed NPIs and two picked by rule below. */
export const FIXTURE_NPIS = {
  "1003215880": "three versions",
  "1003560616": "deactivated, then reactivated",
  "1801771704": "a zero-length version (valid on no day)",
} as const;
const npis = Object.keys(FIXTURE_NPIS).map((n) => `'${n}'`).join(", ");
// Every charge of every item that lists a fixture code, and every code row of those items, so the 3.07x
// charges-to-codes fan-out is present in the fixtures and the semi-join is actually tested.
const items = `SELECT DISTINCT item_id FROM dim_charge_codes WHERE code IN (${codes})
  AND (code_family IS NOT NULL OR declared_type = 'MS-DRG')`;
const slices: Record<TableName, string> = {
  agg_code_prices: `SELECT * FROM agg_code_prices WHERE code IN (${codes}) ORDER BY ALL`,
  files: `SELECT * FROM files ORDER BY hospital_id`,
  dim_charge_codes: `SELECT * FROM dim_charge_codes WHERE item_id IN (${items}) ORDER BY item_id, code_seq`,
  fct_standard_charges: `SELECT * FROM fct_standard_charges WHERE item_id IN (${items}) ORDER BY charge_id`,
  rpt_npi_reconciliation: `SELECT * FROM rpt_npi_reconciliation ORDER BY hospital_id`,
  rpt_npi_resolution: `SELECT * FROM rpt_npi_resolution ORDER BY hospital_id, npi`,
  rpt_source_conformance: `SELECT * FROM rpt_source_conformance ORDER BY ALL`,
  // Sorted by NPI, like the real file. Adds the first deactivation-only stub and the first active-then-deactivated NPI.
  dim_provider_history: `SELECT * FROM dim_provider_history
     WHERE npi IN (${npis})
        OR npi IN (SELECT npi FROM rpt_npi_resolution)
        OR npi = (SELECT min(npi) FROM dim_provider_history WHERE entity_type IS NULL AND npi BETWEEN '1003000000' AND '1013000000')
        OR npi = (SELECT min(npi) FROM dim_provider_history WHERE status = 'deactivated' AND version = 2 AND npi BETWEEN '1003000000' AND '1013000000')
     ORDER BY npi, version`,
};

const files = [];
const tables: Record<string, { key: string[]; rows: number; distinct_keys: number }> = {};
for (const [table, sql] of Object.entries(slices)) {
  const path = join(OUT, `${table}.parquet`).replaceAll("\\", "/");
  const deps: TableName[] = table === "dim_provider_history" ? ["dim_provider_history", "rpt_npi_resolution"]
    : table === "dim_charge_codes" || table === "fct_standard_charges" ? [table, "dim_charge_codes"] : [table as TableName];
  await db.query(deps, `COPY (${sql}) TO '${path}' (FORMAT parquet, COMPRESSION zstd)`);
  const rows = int((await db.query([], `SELECT count(*) AS n FROM read_parquet('${path}')`))[0]?.["n"]);
  const bytes = new Uint8Array(await readFile(path));
  files.push({ file: `${table}.parquet`, rows, bytes: bytes.length, sha256: sha256(bytes) });
  const realCv = (await release.checkValues()).tables[table];
  const key = realCv?.key ?? [];
  const k = await db.query([], `SELECT count(DISTINCT (${key.map((c) => `"${c}"`).join(", ")})) AS k FROM read_parquet('${path}')`);
  tables[table] = { key, rows, distinct_keys: int(k[0]?.["k"]) };
}

// The fixtures' own fan-out: charges joined to every code of their item. Tests assert tools never return this many.
const fx = (t: string): string => `read_parquet('${join(OUT, `${t}.parquet`).replaceAll("\\", "/")}')`;
const [fan] = await db.query(
  [],
  `SELECT count(*) AS n FROM ${fx("fct_standard_charges")} c JOIN ${fx("dim_charge_codes")} d USING (item_id)`,
);
const derived = { charges: tables["fct_standard_charges"]?.rows ?? 0, charge_x_code_rows: int(fan?.["n"]) };
const checkValues = JSON.stringify({ tables, derived }, null, 2) + "\n";
await writeFile(join(OUT, "check_values.json"), checkValues);
const manifest =
  JSON.stringify(
    {
      fingerprint: `fixture-of-${real.fingerprint}`,
      inputs: { price_files: real.inputs.price_files, nppes_files: real.inputs.nppes_files },
      files,
      check_values_sha256: sha256(new TextEncoder().encode(checkValues)),
    },
    null,
    2,
  ) + "\n";
await writeFile(join(OUT, "manifest.json"), manifest);

const pin = { tag: `fixture-${DEFAULT_PIN.tag}`, manifestSha256: sha256(new TextEncoder().encode(manifest)) };
await writeFile(
  join(import.meta.dirname, "..", "tests", "fixtures", "pin.ts"),
  `// Generated by scripts/make-fixtures.ts — do not edit. Regenerate when the default pin moves.\n` +
    `import type { ReleasePin } from "../../src/release.js";\n\n` +
    `export const FIXTURE_PIN: ReleasePin = ${JSON.stringify(pin, null, 2)};\n` +
    `export const FIXTURE_CODES = ${JSON.stringify(Object.keys(FIXTURE_CODES))} as const;\n`,
);
db.close();
console.error(`fixtures written: ${files.map((f) => `${f.file} (${f.rows} rows)`).join(", ")}; pin ${pin.manifestSha256}`);
