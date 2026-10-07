import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { z } from "zod";

// Milestone 0 walking skeleton: one throwaway tool proving a real release row reaches an MCP client.
// Milestone 1 replaces it with release.ts + the real tools.
const BASE = "https://github.com/tjromack/clear-pricer/releases/download/data-2026-10-07-67efd3d2";

export function createServer(): McpServer {
  const server = new McpServer({ name: "clear-pricer-mcp", version: "0.0.0" });

  server.registerTool(
    "spike_code_prices",
    {
      title: "Spike: one code across hospitals",
      description: "Milestone 0 only. Contracted-dollar prices for one billing code from the pinned release.",
      inputSchema: { code: z.string().regex(/^[0-9A-Z]{4,7}$/) },
      outputSchema: {
        rows: z.array(
          z.object({ hospital_id: z.string(), setting: z.string(), charge_rows: z.number().int(), rate_median: z.number() }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ code }) => {
      const db = await DuckDBInstance.create(":memory:");
      const conn = await db.connect();
      const reader = await conn.runAndReadAll(
        `SELECT hospital_id, setting, charge_rows, rate_median
           FROM '${BASE}/agg_code_prices.parquet'
          WHERE code = $code AND rate_basis = 'dollar' ORDER BY hospital_id, setting`,
        { code },
      );
      const rows = reader.getRowObjects().map((r) => ({
        hospital_id: String(r["hospital_id"]),
        setting: String(r["setting"]),
        charge_rows: Number(r["charge_rows"]),
        rate_median: Number(r["rate_median"]),
      }));
      conn.closeSync();
      return { content: [{ type: "text", text: JSON.stringify(rows) }], structuredContent: { rows } };
    },
  );

  return server;
}
