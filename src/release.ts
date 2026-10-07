import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import envPaths from "env-paths";
import { z } from "zod";

/**
 * The trust root (CPM-DEC 007): a tag plus the SHA-256 of that tag's manifest.json. The manifest hashes every file
 * and check_values.json, so verifying it first makes the whole release checkable from this one committed value.
 */
export interface ReleasePin {
  readonly tag: string;
  readonly manifestSha256: string;
}

export const DEFAULT_PIN: ReleasePin = {
  tag: "data-2026-10-07-67efd3d2",
  manifestSha256: "b46cbb9f98c0959b2a34d4852546a20e5baad6763f3acfa52e79174bed25ac04",
};

/** Files read by HTTP range instead of downloaded (CPM-DEC 002). Row-count-checked against the manifest, not hashed. */
export const REMOTE_FILES: ReadonlySet<string> = new Set(["dim_provider_history.parquet"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

const manifestSchema = z.object({
  fingerprint: z.string(),
  inputs: z.object({
    price_files: z.array(
      z.object({ hospital_id: z.string(), source_sha256: z.string(), last_updated_on: z.string() }),
    ),
    nppes_files: z.array(z.string()),
  }),
  files: z.array(
    z.object({
      file: z.string(),
      rows: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(SHA256_HEX),
    }),
  ),
  check_values_sha256: z.string().regex(SHA256_HEX),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = Manifest["files"][number];

const checkValuesSchema = z.object({
  tables: z.record(
    z.string(),
    z.object({ key: z.array(z.string()), rows: z.number().int(), distinct_keys: z.number().int() }),
  ),
  derived: z.record(z.string(), z.number()),
});
export type CheckValues = z.infer<typeof checkValuesSchema>;

/** The release could not be verified. The server refuses to answer from it rather than serve unverified data. */
export class ReleaseIntegrityError extends Error {
  override readonly name = "ReleaseIntegrityError";
}

/** Where release bytes come from: GitHub in production, a fixture directory in tests. */
export interface ReleaseSource {
  /** Human-readable origin, shown in provenance and errors. */
  readonly origin: string;
  fetch(name: string): Promise<Uint8Array>;
  /** A URL (or path) DuckDB can range-read, for remote files. */
  url(name: string): string;
}

/** Retry transient network failures (connection resets, DNS blips) with backoff; HTTP errors are not retried. */
async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= attempts) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
        const tls = /certificate/i.test(cause)
          ? " The certificate error usually means a TLS-inspecting proxy: give Node its CA by setting " +
            "NODE_EXTRA_CA_CERTS (or NODE_OPTIONS=--use-system-ca) in this server's env in your MCP client config."
          : " The server needs network access the first time each table is used; try again.";
        throw new ReleaseIntegrityError(
          `Could not reach ${new URL(url).host} to read ${url.split("/").pop() ?? url} after ${attempts} attempts ` +
            `(${cause}).${tls}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
}

export function githubSource(tag: string): ReleaseSource {
  const base = `https://github.com/tjromack/clear-pricer/releases/download/${tag}`;
  return {
    origin: base,
    async fetch(name) {
      const res = await fetchWithRetry(`${base}/${name}`);
      if (!res.ok) throw new ReleaseIntegrityError(`Could not download ${name} from ${base}: HTTP ${res.status}.`);
      return new Uint8Array(await res.arrayBuffer());
    },
    url: (name) => `${base}/${name}`,
  };
}

export function directorySource(dir: string): ReleaseSource {
  return {
    origin: dir,
    async fetch(name) {
      try {
        return new Uint8Array(await readFile(join(dir, name)));
      } catch {
        throw new ReleaseIntegrityError(`${name} is not in ${dir}.`);
      }
    },
    url: (name) => join(dir, name).replaceAll("\\", "/"),
  };
}

/**
 * Resolve the pin from the environment. Overriding the tag without its manifest hash is refused: a tag alone is a
 * mutable pointer, and the point of the pin is that the answer key cannot move underneath the tests.
 */
export function resolvePin(env: NodeJS.ProcessEnv = process.env): ReleasePin {
  const tag = env["CLEAR_PRICER_RELEASE"];
  const sha = env["CLEAR_PRICER_MANIFEST_SHA256"];
  if (tag === undefined && sha === undefined) return DEFAULT_PIN;
  if (tag === undefined || sha === undefined || !SHA256_HEX.test(sha)) {
    throw new ReleaseIntegrityError(
      "CLEAR_PRICER_RELEASE and CLEAR_PRICER_MANIFEST_SHA256 must be set together; the hash is the 64-character " +
        "lowercase SHA-256 of that release's manifest.json. Unset both to use the default pinned release " +
        `${DEFAULT_PIN.tag}.`,
    );
  }
  return { tag, manifestSha256: sha };
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLEAR_PRICER_CACHE_DIR"] ?? envPaths("clear-pricer-mcp", { suffix: "" }).cache;
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type FileStatus = "verified" | "not_downloaded" | "remote";

/**
 * One pinned release: verifies the manifest against the pin, then every file against the manifest, caching verified
 * files under <cacheDir>/<tag>/. Nothing unverified is ever handed to DuckDB.
 */
export class Release {
  readonly pin: ReleasePin;
  readonly source: ReleaseSource;
  private readonly dir: string;
  private manifestPromise: Promise<Manifest> | undefined;
  private checkValuesPromise: Promise<CheckValues> | undefined;
  private readonly files = new Map<string, Promise<string>>();
  private readonly verified = new Set<string>();

  constructor(pin: ReleasePin, source: ReleaseSource, cacheDir: string) {
    this.pin = pin;
    this.source = source;
    this.dir = join(cacheDir, pin.tag);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Release {
    const pin = resolvePin(env);
    return new Release(pin, githubSource(pin.tag), defaultCacheDir(env));
  }

  manifest(): Promise<Manifest> {
    this.manifestPromise ??= this.loadVerified("manifest.json", this.pin.manifestSha256).then((bytes) =>
      manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
    );
    // A failed load is not cached: the next call retries (a network blip should not wedge the server).
    this.manifestPromise.catch(() => (this.manifestPromise = undefined));
    return this.manifestPromise;
  }

  checkValues(): Promise<CheckValues> {
    this.checkValuesPromise ??= this.manifest()
      .then((m) => this.loadVerified("check_values.json", m.check_values_sha256))
      .then((bytes) => checkValuesSchema.parse(JSON.parse(new TextDecoder().decode(bytes))));
    this.checkValuesPromise.catch(() => (this.checkValuesPromise = undefined));
    return this.checkValuesPromise;
  }

  async manifestEntry(name: string): Promise<ManifestFile> {
    const entry = (await this.manifest()).files.find((f) => f.file === name);
    if (!entry) throw new ReleaseIntegrityError(`${name} is not listed in the manifest of release ${this.pin.tag}.`);
    return entry;
  }

  /** Local path of a downloaded, SHA-256-verified release file. */
  localFile(name: string): Promise<string> {
    if (REMOTE_FILES.has(name)) throw new Error(`${name} is read remotely; use remoteFile().`);
    let p = this.files.get(name);
    if (!p) {
      p = this.manifestEntry(name).then(async (entry) => {
        await this.loadVerified(name, entry.sha256);
        return join(this.dir, name);
      });
      p.catch(() => this.files.delete(name));
      this.files.set(name, p);
    }
    return p;
  }

  /**
   * Location of a range-read file and the row count the manifest promises for it. No network here: the caller
   * (Db) checks the count against the file's Parquet footer through DuckDB, the same client that reads the file.
   */
  async remoteFile(name: string): Promise<{ location: string; rows: number }> {
    if (!REMOTE_FILES.has(name)) throw new Error(`${name} is downloaded and hash-checked; use localFile().`);
    const entry = await this.manifestEntry(name);
    return { location: this.source.url(name), rows: entry.rows };
  }

  /** Per-file status without downloading anything new. A cached file is hashed once per process, then remembered. */
  async status(): Promise<Map<string, FileStatus>> {
    const out = new Map<string, FileStatus>();
    for (const f of (await this.manifest()).files) {
      if (REMOTE_FILES.has(f.file)) out.set(f.file, "remote");
      else if (this.verified.has(f.file) || (await this.cachedMatches(f.file, f.sha256))) out.set(f.file, "verified");
      else out.set(f.file, "not_downloaded");
    }
    return out;
  }

  private async cachedMatches(name: string, expected: string): Promise<boolean> {
    try {
      const ok = sha256(new Uint8Array(await readFile(join(this.dir, name)))) === expected;
      if (ok) this.verified.add(name);
      return ok;
    } catch {
      return false;
    }
  }

  /** Cached copy if it still matches; otherwise fetch, verify, and write atomically. Never returns unverified bytes. */
  private async loadVerified(name: string, expected: string): Promise<Uint8Array> {
    const path = join(this.dir, name);
    try {
      const cached = new Uint8Array(await readFile(path));
      if (sha256(cached) === expected) {
        this.verified.add(name);
        return cached;
      }
      await rm(path, { force: true }); // corrupted or stale cache entry: discard and re-fetch
    } catch {
      // not cached yet
    }
    const bytes = await this.source.fetch(name);
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new ReleaseIntegrityError(
        `Refusing to serve release ${this.pin.tag}: ${name} from ${this.source.origin} has SHA-256 ${actual}, ` +
          `expected ${expected}. The published file does not match the pinned release.`,
      );
    }
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    this.verified.add(name);
    return bytes;
  }
}
