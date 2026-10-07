import { z } from "zod";
import { str, type Db } from "./db.js";

/** Where a row came from: the hospital's own file, by name and hash, as captured in the pinned release. */
export const provenanceSchema = z.object({
  release_tag: z.string().describe("The clear-pricer data release these rows come from"),
  table: z.string().describe("Release table the row was read from"),
  hospital_id: z.string(),
  hospital_name: z.string().describe("As the hospital names itself in its price file"),
  source_filename: z.string().describe("The hospital's machine-readable price file"),
  source_sha256: z.string().describe("SHA-256 of that file as downloaded by clear-pricer"),
  source_last_updated_on: z.string().describe("The file's own last-updated date (the hospital's effective date)"),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export type HospitalSource = Omit<Provenance, "release_tag" | "table">;

/** One entry per hospital in the release, from its `files` table. */
export async function hospitalSources(db: Db): Promise<Map<string, HospitalSource>> {
  const rows = await db.query(
    ["files"],
    `SELECT hospital_id, hospital_name, source_filename, source_sha256, last_updated_on
       FROM files ORDER BY hospital_id`,
  );
  return new Map(
    rows.map((r) => [
      str(r["hospital_id"]),
      {
        hospital_id: str(r["hospital_id"]),
        hospital_name: str(r["hospital_name"]),
        source_filename: str(r["source_filename"]),
        source_sha256: str(r["source_sha256"]),
        source_last_updated_on: str(r["last_updated_on"]),
      },
    ]),
  );
}

export function provenance(db: Db, table: string, source: HospitalSource): Provenance {
  return { release_tag: db.release.pin.tag, table, ...source };
}
