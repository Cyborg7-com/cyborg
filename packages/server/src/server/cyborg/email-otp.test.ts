import { describe, expect, it } from "vitest";
import { generateOtpCode, hashOtpCode, verifyOtpCode, otpExpiry, OTP_TTL_MS } from "./email-otp.js";

describe("email-otp", () => {
  it("generates a zero-padded 6-digit numeric code", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("hashes the code (never stores plaintext) and is deterministic", () => {
    const code = "123456";
    const hash = hashOtpCode(code);
    expect(hash).not.toContain(code);
    expect(hash).toHaveLength(64); // sha256 hex
    expect(hashOtpCode(code)).toBe(hash);
  });

  it("verifies a correct code and rejects an incorrect one", () => {
    const code = generateOtpCode();
    const hash = hashOtpCode(code);
    expect(verifyOtpCode(code, hash)).toBe(true);

    const wrong = code === "000000" ? "000001" : "000000";
    expect(verifyOtpCode(wrong, hash)).toBe(false);
  });

  it("rejects a code whose hash has the wrong length without throwing", () => {
    expect(verifyOtpCode("123456", "deadbeef")).toBe(false);
  });

  it("sets an expiry roughly OTP_TTL_MS in the future", () => {
    const before = Date.now();
    const expiry = otpExpiry().getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + OTP_TTL_MS - 1000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + OTP_TTL_MS + 1000);
  });
});
