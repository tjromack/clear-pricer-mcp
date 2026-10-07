// Spawns the compiled server over stdio (as an MCP client would) and asks it one real question. npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2).length ? process.argv.slice(2) : [process.execPath, "dist/index.js"];
const client = new Client({ name: "smoke", version: "0.0.0" });
// An MCP client passes only a whitelist of env vars to the server. Behind a TLS-inspecting proxy the CA has to be
// passed explicitly, exactly as a user would in their client's server config (README: "Behind a corporate proxy").
const env: Record<string, string> = { ...getDefaultEnvironment() };
if (process.env["NODE_EXTRA_CA_CERTS"]) env["NODE_EXTRA_CA_CERTS"] = process.env["NODE_EXTRA_CA_CERTS"];
await client.connect(new StdioClientTransport({ command: command ?? process.execPath, args, env }));

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
const calls: [string, Record<string, unknown>][] = [
  ["release_info", {}],
  ["find_codes", { query: "mri brain" }],
  ["compare_code_prices", { code: "99213" }],
  ["get_payer_rates", { code: "99213", hospital_id: "rush", limit: 5 }],
  ["lookup_provider", { npi: "1497859649" }],
  ["data_quality", {}],
];
for (const [name, a] of calls) {
  const res = await client.callTool({ name, arguments: a });
  const body = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  console.log(`\n${name}${res.isError ? " (ERROR)" : ""}:\n${body}`);
  if (res.isError) process.exitCode = 1;
}
await client.close();
