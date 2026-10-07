// Spawns the compiled server over stdio (as an MCP client would) and asks it one real question. npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2).length ? process.argv.slice(2) : [process.execPath, "dist/index.js"];
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: command ?? process.execPath, args }));

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
for (const [name, a] of [["release_info", {}], ["compare_code_prices", { code: "99213" }]] as const) {
  const res = await client.callTool({ name, arguments: a });
  const body = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  console.log(`\n${name}${res.isError ? " (ERROR)" : ""}:\n${body}`);
  if (res.isError) process.exitCode = 1;
}
await client.close();
