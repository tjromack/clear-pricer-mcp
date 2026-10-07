#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Db } from "./db.js";
import { Release } from "./release.js";
import { createServer } from "./server.js";

// stdout is the MCP channel. Everything else goes to stderr.
try {
  const release = Release.fromEnv();
  const db = await Db.open(release);
  await createServer(db).connect(new StdioServerTransport());
  console.error(`clear-pricer-mcp: ready on stdio, serving release ${release.pin.tag}`);
} catch (err) {
  console.error(`clear-pricer-mcp: failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
