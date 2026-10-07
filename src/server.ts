import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "./db.js";
import { registerCompareCodePrices } from "./tools/compare_code_prices.js";
import { registerReleaseInfo } from "./tools/release_info.js";

export const SERVER_VERSION = "0.1.0";

/** Registers the tools only; no SQL and no I/O here, so tests can hand it a Db over fixtures. */
export function createServer(db: Db): McpServer {
  const server = new McpServer(
    { name: "clear-pricer-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to clear-pricer's public data release: hospital price-transparency files from three Chicago " +
        "hospitals (Northwestern Memorial, Rush, UChicago Medical Center) and the NPPES provider registry. Every row " +
        "cites the hospital's source file. Published negotiated rates are not what any given patient pays.",
    },
  );
  registerCompareCodePrices(server, db);
  registerReleaseInfo(server, db);
  return server;
}
