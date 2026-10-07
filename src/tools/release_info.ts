import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db.js";

export const outputSchema = {
  release_tag: z.string(),
  manifest_sha256: z.string().describe("Pinned in this server's source; the manifest is verified against it"),
  fingerprint: z.string().describe("clear-pricer's fingerprint of the release inputs"),
  origin: z.string().describe("Where the release files are fetched from"),
  check_values_verified: z.boolean().describe("check_values.json matched the manifest's hash"),
  price_files: z.array(
    z.object({ hospital_id: z.string(), source_sha256: z.string(), last_updated_on: z.string() }),
  ),
  nppes_files: z.array(z.string()),
  files: z.array(
    z.object({
      file: z.string(),
      rows: z.number().int(),
      bytes: z.number().int(),
      sha256: z.string(),
      status: z
        .enum(["verified", "not_downloaded", "remote"])
        .describe("verified = cached and hash-checked; not_downloaded = fetched on first use; remote = range-read"),
    }),
  ),
};

type Output = z.infer<z.ZodObject<typeof outputSchema>>;

export async function releaseInfo(db: Db): Promise<Output> {
  const { release } = db;
  const manifest = await release.manifest();
  await release.checkValues(); // throws ReleaseIntegrityError on a mismatch
  const status = await release.status();
  return {
    release_tag: release.pin.tag,
    manifest_sha256: release.pin.manifestSha256,
    fingerprint: manifest.fingerprint,
    origin: release.source.origin,
    check_values_verified: true,
    price_files: manifest.inputs.price_files,
    nppes_files: manifest.inputs.nppes_files,
    files: manifest.files.map((f) => ({ ...f, status: status.get(f.file) ?? "not_downloaded" })),
  };
}

export function registerReleaseInfo(server: McpServer, db: Db): void {
  server.registerTool(
    "release_info",
    {
      title: "Which data release is being served",
      description:
        "The pinned clear-pricer release this server answers from: its tag, the manifest hash it was verified " +
        "against, the hospital price files and NPPES files it was built from, and each table's row count and status.",
      inputSchema: {},
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const out = await releaseInfo(db);
      const text =
        `Release ${out.release_tag} (manifest ${out.manifest_sha256.slice(0, 12)}…, verified). Built from ` +
        out.price_files.map((p) => `${p.hospital_id} (updated ${p.last_updated_on})`).join(", ") +
        ` and ${out.nppes_files.length} NPPES files. ${out.files.length} tables.`;
      return { content: [{ type: "text", text }], structuredContent: out };
    },
  );
}
