import { describe, expect, it } from "vitest";
import { partitionFilesBySize } from "./composer-attachment-validation.js";

// Minimal File-like stand-in (the helper only reads name/size). vitest's node
// env has no File constructor, so fake the shape the partition inspects.
function file(name: string, size: number): File {
  return { name, size } as unknown as File;
}

const MAX = 50; // tiny cap for the test

describe("partitionFilesBySize", () => {
  it("accepts files at or below the cap, rejects strictly-larger ones", () => {
    const { accepted, rejected } = partitionFilesBySize(
      [file("a.png", 10), file("big.mov", 51), file("edge.txt", 50)],
      MAX,
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.png", "edge.txt"]);
    expect(rejected).toEqual([{ name: "big.mov", size: 51 }]);
  });

  it("treats a file exactly AT the cap as accepted (boundary: > not >=)", () => {
    const { accepted, rejected } = partitionFilesBySize([file("exact", MAX)], MAX);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("preserves input order in both buckets", () => {
    const { accepted, rejected } = partitionFilesBySize(
      [file("ok1", 1), file("no1", 99), file("ok2", 2), file("no2", 88)],
      MAX,
    );
    expect(accepted.map((f) => f.name)).toEqual(["ok1", "ok2"]);
    expect(rejected.map((r) => r.name)).toEqual(["no1", "no2"]);
  });

  it("returns empty buckets for an empty list", () => {
    expect(partitionFilesBySize([], MAX)).toEqual({ accepted: [], rejected: [] });
  });

  it("all-oversized → empty accepted, every file rejected with name + size", () => {
    const { accepted, rejected } = partitionFilesBySize([file("x", 100), file("y", 200)], MAX);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "x", size: 100 },
      { name: "y", size: 200 },
    ]);
  });

  it("accepts a FileList-like (array-like) input via Array.from", () => {
    const arrayLike = {
      0: file("a", 1),
      1: file("b", 999),
      length: 2,
      [Symbol.iterator](this: { length: number; [k: number]: File }) {
        let i = 0;
        return {
          next: () =>
            i < this.length ? { value: this[i++], done: false } : { value: undefined, done: true },
        };
      },
    } as unknown as FileList;
    const { accepted, rejected } = partitionFilesBySize(arrayLike, MAX);
    expect(accepted.map((f) => f.name)).toEqual(["a"]);
    expect(rejected.map((r) => r.name)).toEqual(["b"]);
  });
});
