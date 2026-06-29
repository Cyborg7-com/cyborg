import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail } from "./email.js";

describe("normalizeEmail", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeEmail("  Foo.Bar@Example.COM  ")).toBe("foo.bar@example.com");
    expect(normalizeEmail("user@domain.com")).toBe("user@domain.com");
  });
});

describe("isValidEmail", () => {
  it("accepts well-formed single addresses (incl. plus-addressing and subdomains)", () => {
    for (const e of [
      "fabriciojallazam@gmail.com",
      "e2e-invite-check@example.com",
      "user+tag@sub.domain.co",
      "a_b.c%d@x-y.io",
    ]) {
      expect(isValidEmail(e)).toBe(true);
    }
  });

  it("rejects the trailing-comma junk that actually got stored", () => {
    // This is the exact value found in production: a paste with a stray comma.
    expect(isValidEmail("luischavezc2024@gmail.com,")).toBe(false);
  });

  it("rejects multi-address strings, whitespace, and missing parts", () => {
    for (const e of [
      "a@b.com, c@d.com",
      "spaces in@email.com",
      "no-at-sign.com",
      "missingtld@host",
      "trailingdot@host.",
      "@nodomain.com",
      "nolocal@",
      "",
    ]) {
      expect(isValidEmail(e)).toBe(false);
    }
  });
});
