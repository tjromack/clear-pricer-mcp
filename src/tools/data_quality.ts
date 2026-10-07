import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { int, numOrNull, str, strOrNull, type Db, type Row } from "../db.js";
import { hospitalSources, provenance, provenanceSchema } from "../provenance.js";
import { HOSPITAL_IDS, hospitalIdSchema, type HospitalId } from "../vocab.js";

export const inputSchema = {
  hospital_id: hospitalIdSchema.optional().describe("One hospital; omit for all three"),
};

const reconciliationSchema = z.object({
  disclosed_npis: z.number().int().describe("NPIs the hospital's price file lists"),
  verified_npis: z.number().int().describe("Disclosed NPIs that resolve in NPPES to this hospital"),
  unresolved_npis: z.number().int(),
  unresolved_rate: z.number(),
  verified_rate: z.number(),
  undisclosed_candidates: z.number().int().describe("Hospital NPIs found in NPPES near the hospital but not disclosed"),
  disclosure_coverage: z.number().describe("disclosed / (disclosed + undisclosed candidates)"),
});

export const outputSchema = {
  release_tag: z.string(),
  overall: reconciliationSchema.describe("clear-pricer's published ALL row across the three hospitals; not recomputed here"),
  hospitals: z.array(
    z.object({
      hospital_id: z.enum(HOSPITAL_IDS),
      hospital_name: z.string(),
      records_read: z.number().int().describe("Records the pipeline read from the hospital's file"),
      charge_rows: z.number().int().describe("Charge rows that passed into the release"),
      quarantined_rows: z.number().int().describe("Rows set aside as unparseable, counted rather than dropped"),
      npi_reconciliation: reconciliationSchema,
      disclosed_npis: z.array(
        z.object({ npi: z.string(), outcome: z.string(), nppes_name: z.string().nullable(), status: z.string().nullable() }),
      ),
      conformance: z
        .array(
          z.object({
            kind: z.string(),
            column: z.string(),
            records: z.number().int(),
            share_of_records: z.number(),
            sample_value: z.string().nullable(),
            first_locator: z.string().nullable(),
          }),
        )
        .describe("Ways the hospital's file departs from the CMS template, and how often"),
      provenance: provenanceSchema,
    }),
  ),
  notes: z.array(z.string()),
};

type Output = z.infer<z.ZodObject<typeof outputSchema>>;

const reconciliation = (r: Row): z.infer<typeof reconciliationSchema> => ({
  disclosed_npis: int(r["disclosed_npis"]),
  verified_npis: int(r["verified_npis"]),
  unresolved_npis: int(r["unresolved_npis"]),
  unresolved_rate: numOrNull(r["unresolved_rate"]) ?? 0,
  verified_rate: numOrNull(r["verified_rate"]) ?? 0,
  undisclosed_candidates: int(r["undisclosed_candidates"]),
  disclosure_coverage: numOrNull(r["disclosure_coverage"]) ?? 0,
});

export async function dataQuality(db: Db, input: { hospital_id?: HospitalId | undefined }): Promise<Output> {
  const ids = input.hospital_id ? [input.hospital_id] : [...HOSPITAL_IDS];
  // rpt_npi_reconciliation carries its own total as the 'ALL' row; it is read, never summed with the hospital rows.
  const recon = await db.query(["rpt_npi_reconciliation"], "SELECT * FROM rpt_npi_reconciliation ORDER BY hospital_id");
  const overall = recon.find((r) => str(r["hospital_id"]) === "ALL");
  if (!overall) throw new Error("rpt_npi_reconciliation has no ALL row");
  const npis = await db.query(["rpt_npi_resolution"], "SELECT * FROM rpt_npi_resolution ORDER BY hospital_id, npi");
  const conf = await db.query(
    ["rpt_source_conformance"],
    `SELECT * FROM rpt_source_conformance ORDER BY hospital_id, n DESC, kind, "column"`,
  );
  const files = await db.query(["files"], "SELECT hospital_id, records_read, charge_rows, quarantined_rows FROM files");
  const sources = await hospitalSources(db);

  const hospitals = ids.map((id) => {
    const source = sources.get(id);
    const r = recon.find((x) => str(x["hospital_id"]) === id);
    const f = files.find((x) => str(x["hospital_id"]) === id);
    if (!source || !r || !f) throw new Error(`hospital ${id} is missing from a release report table`);
    return {
      hospital_id: id,
      hospital_name: source.hospital_name,
      records_read: int(f["records_read"]),
      charge_rows: int(f["charge_rows"]),
      quarantined_rows: int(f["quarantined_rows"]),
      npi_reconciliation: reconciliation(r),
      disclosed_npis: npis
        .filter((n) => str(n["hospital_id"]) === id)
        .map((n) => ({
          npi: str(n["npi"]),
          outcome: str(n["outcome"]),
          nppes_name: strOrNull(n["nppes_name"]),
          status: strOrNull(n["status"]),
        })),
      conformance: conf
        .filter((c) => str(c["hospital_id"]) === id)
        .map((c) => ({
          kind: str(c["kind"]),
          column: str(c["column"]),
          records: int(c["n"]),
          share_of_records: numOrNull(c["share_of_records"]) ?? 0,
          sample_value: strOrNull(c["sample_value"]),
          first_locator: strOrNull(c["first_locator"]),
        })),
      provenance: provenance(db, "rpt_npi_reconciliation, rpt_npi_resolution, rpt_source_conformance, files", source),
    };
  });

  return {
    release_tag: db.release.pin.tag,
    overall: reconciliation(overall),
    hospitals,
    notes: [
      "overall is clear-pricer's own ALL row. Adding it to the hospital rows would count every NPI twice.",
      "Conformance lists how each file departs from the CMS machine-readable template; the pipeline handled each " +
        "case and kept a count rather than dropping rows silently.",
    ],
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function registerDataQuality(server: McpServer, db: Db): void {
  server.registerTool(
    "data_quality",
    {
      title: "How far to trust each hospital's price file",
      description:
        "Per hospital: whether the NPIs its price file discloses resolve to it in NPPES, how many of its NPIs it " +
        "leaves undisclosed, how its file departs from the CMS template (and how often), and rows quarantined. Use " +
        "it to qualify any price answer.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const out = await dataQuality(db, input);
      const lines = out.hospitals.map(
        (h) =>
          `- ${h.hospital_name}: ${h.npi_reconciliation.verified_npis}/${h.npi_reconciliation.disclosed_npis} disclosed NPIs ` +
          `verified, disclosure coverage ${pct(h.npi_reconciliation.disclosure_coverage)}, ${h.conformance.length} ` +
          `template deviations, ${h.quarantined_rows} rows quarantined`,
      );
      lines.push(`Overall (published ALL row): unresolved ${pct(out.overall.unresolved_rate)}, coverage ${pct(out.overall.disclosure_coverage)}.`);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: out };
    },
  );
}
