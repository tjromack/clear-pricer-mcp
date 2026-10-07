// Milestone 0 gate: a real MCP client (SDK Client over stdio, a spawned process) lists the tool and gets a release row.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: process.argv[2] === "dist" ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"] });
const client = new Client({ name: "spike-client", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name));
const res = await client.callTool({ name: "spike_code_prices", arguments: { code: "99213" } });
console.log("structuredContent:", JSON.stringify(res.structuredContent, null, 2));
const bad = await client.callTool({ name: "spike_code_prices", arguments: { code: "x; DROP" } });
console.log("bad input isError:", bad.isError, JSON.stringify(bad.content).slice(0, 160));
await client.close();
