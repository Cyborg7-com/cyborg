import { describe, it, expect } from "vitest";
import { escapeLikePattern } from "./pg-sync.js";

describe("escapeLikePattern", () => {
  it("escapes backslash, percent, and underscore", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("c:\\x")).toBe("c:\\\\x");
    expect(escapeLikePattern("a%_\\b")).toBe("a\\%\\_\\\\b");
  });
  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });
});
