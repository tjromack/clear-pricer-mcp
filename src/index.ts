#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout is the MCP channel. Everything else goes to stderr.
const server = createServer();
await server.connect(new StdioServerTransport());
console.error("clear-pricer-mcp: ready on stdio");
