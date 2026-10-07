import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Db } from "../src/db.js";
import { Release, directorySource } from "../src/release.js";
import { createServer } from "../src/server.js";
import { FIXTURE_PIN } from "./fixtures/pin.js";

export const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "release");

export async function tempDir(): Promise<{ path: string; [Symbol.asyncDispose](): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "cpm-test-"));
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}

export function fixtureRelease(cacheDir: string, dir = FIXTURE_DIR, pin = FIXTURE_PIN): Release {
  return new Release(pin, directorySource(dir), cacheDir);
}

export interface Connected {
  db: Db;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  client: Client;
}

/** A real MCP client connected in-process to the server, over a given release (the fixture release by default). */
export async function connect(release?: Release): Promise<Connected> {
  const cache = await tempDir();
  const db = await Db.open(release ?? fixtureRelease(cache.path));
  const server = createServer(db);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "contract-tests", version: "0.0.0" });
  await client.connect(clientT);
  await client.listTools(); // caches outputSchema validators, so the client checks structuredContent too
  return {
    client,
    db,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
      db.close();
      await cache[Symbol.asyncDispose]();
    },
  };
}

export const text = (r: CallToolResult): string =>
  r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
