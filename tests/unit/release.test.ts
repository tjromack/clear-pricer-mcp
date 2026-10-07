import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PIN, Release, ReleaseIntegrityError, directorySource, resolvePin, sha256 } from "../../src/release.js";
import { FIXTURE_PIN } from "../fixtures/pin.js";
import { FIXTURE_DIR, fixtureRelease, tempDir } from "../helpers.js";

const bytesOf = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));

describe("release verification chain", () => {
  it("verifies the manifest against the pin, then files against the manifest, and caches them", async () => {
    await using cache = await tempDir();
    const release = fixtureRelease(cache.path);
    expect((await release.status()).get("agg_code_prices.parquet")).toBe("not_downloaded");
    const path = await release.localFile("agg_code_prices.parquet");
    const entry = await release.manifestEntry("agg_code_prices.parquet");
    expect(sha256(await bytesOf(path))).toBe(entry.sha256);
    expect((await release.status()).get("agg_code_prices.parquet")).toBe("verified");
    expect((await release.checkValues()).tables["agg_code_prices"]?.rows).toBe(entry.rows);
  });

  it("refuses a manifest that does not match the pinned hash", async () => {
    await using cache = await tempDir();
    const release = fixtureRelease(cache.path, FIXTURE_DIR, { ...FIXTURE_PIN, manifestSha256: "0".repeat(64) });
    await expect(release.manifest()).rejects.toThrow(ReleaseIntegrityError);
    await expect(release.localFile("files.parquet")).rejects.toThrow(/Refusing to serve/);
  });

  it("refuses a file whose bytes no longer match the manifest, and keeps serving the files that do", async () => {
    await using cache = await tempDir();
    await using src = await tempDir();
    await cp(FIXTURE_DIR, src.path, { recursive: true });
    const target = join(src.path, "agg_code_prices.parquet");
    const bytes = await bytesOf(target);
    bytes[200] = (bytes[200] ?? 0) ^ 0xff;
    await writeFile(target, bytes);

    const release = fixtureRelease(cache.path, src.path);
    await expect(release.localFile("agg_code_prices.parquet")).rejects.toThrow(/agg_code_prices\.parquet .*SHA-256/s);
    await expect(release.localFile("files.parquet")).resolves.toContain("files.parquet");
  });

  it("discards a corrupted cache entry and re-fetches a verified copy", async () => {
    await using cache = await tempDir();
    const path = await fixtureRelease(cache.path).localFile("files.parquet");
    await writeFile(path, "not parquet");

    const restarted = fixtureRelease(cache.path); // a new process finds the corrupted file
    await restarted.localFile("files.parquet");
    expect(sha256(await bytesOf(path))).toBe((await restarted.manifestEntry("files.parquet")).sha256);
  });

  it("refuses a remote file whose size differs from the manifest", async () => {
    await using cache = await tempDir();
    await using src = await tempDir();
    await writeFile(join(src.path, "dim_provider_history.parquet"), "12345678901"); // 11 bytes; manifest says 10
    const checkValues = JSON.stringify({ tables: {}, derived: {} });
    await writeFile(join(src.path, "check_values.json"), checkValues);
    const manifest = JSON.stringify({
      fingerprint: "test",
      inputs: { price_files: [], nppes_files: [] },
      files: [{ file: "dim_provider_history.parquet", rows: 1, bytes: 10, sha256: "a".repeat(64) }],
      check_values_sha256: sha256(new TextEncoder().encode(checkValues)),
    });
    await writeFile(join(src.path, "manifest.json"), manifest);
    const pin = { tag: "size-test", manifestSha256: sha256(new TextEncoder().encode(manifest)) };

    const release = new Release(pin, directorySource(src.path), cache.path);
    await expect(release.remoteFile("dim_provider_history.parquet")).rejects.toThrow(/11 bytes.*says 10/s);
    expect((await release.status()).get("dim_provider_history.parquet")).toBe("remote");
  });

  it("refuses a file the manifest does not list", async () => {
    await using cache = await tempDir();
    await expect(fixtureRelease(cache.path).localFile("not_a_table.parquet")).rejects.toThrow(/not listed/);
  });
});

describe("resolvePin", () => {
  it("uses the default pin when nothing is set", () => {
    expect(resolvePin({})).toEqual(DEFAULT_PIN);
  });
  it("refuses a tag without its manifest hash", () => {
    expect(() => resolvePin({ CLEAR_PRICER_RELEASE: "data-2026-01-01-x" })).toThrow(/must be set together/);
  });
  it("refuses a malformed hash", () => {
    expect(() => resolvePin({ CLEAR_PRICER_RELEASE: "t", CLEAR_PRICER_MANIFEST_SHA256: "abc" })).toThrow(
      ReleaseIntegrityError,
    );
  });
  it("accepts a tag with its hash", () => {
    const env = { CLEAR_PRICER_RELEASE: "t", CLEAR_PRICER_MANIFEST_SHA256: "f".repeat(64) };
    expect(resolvePin(env)).toEqual({ tag: "t", manifestSha256: "f".repeat(64) });
  });
});
