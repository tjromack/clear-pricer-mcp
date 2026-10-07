import { describe, expect, it } from "vitest";
import { int, numOrNull, str, strOrNull } from "../../src/db.js";

describe("DuckDB value conversion", () => {
  it("converts BIGINT (returned as bigint) to number inside the safe range", () => {
    expect(int(30n)).toBe(30);
    expect(() => int(2n ** 60n)).toThrow(RangeError);
  });
  it("rejects non-integers and NULL where an integer is required", () => {
    expect(() => int(1.5)).toThrow(TypeError);
    expect(() => int(null)).toThrow(TypeError);
  });
  it("keeps NULL as null for nullable numbers and strings", () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(61.65)).toBe(61.65);
    expect(strOrNull(null)).toBeNull();
    expect(() => str(null)).toThrow(TypeError);
  });
});
