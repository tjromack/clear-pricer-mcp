import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseIntegrityError, githubSource } from "../../src/release.js";

afterEach(() => vi.unstubAllGlobals());

const dropped = (): never => {
  throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
};

describe("githubSource network handling", () => {
  it("retries a dropped connection and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(dropped)
      .mockImplementationOnce(dropped)
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubSource("t").fetch("f.parquet")).resolves.toEqual(new TextEncoder().encode("ok"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts with an actionable message instead of 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(dropped));
    const err = await githubSource("t").fetch("files.parquet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseIntegrityError);
    expect(String(err)).toMatch(/Could not reach github\.com to read files\.parquet after 3 attempts \(ECONNRESET\)/);
  });

  it("names the proxy fix when the failure is a certificate error", async () => {
    const certError = (): never => {
      throw new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") });
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(certError));
    await expect(githubSource("t").fetch("x.parquet")).rejects.toThrow(/TLS-inspecting proxy: .*NODE_EXTRA_CA_CERTS/s);
  });

  it("does not retry an HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubSource("t").fetch("x.parquet")).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
