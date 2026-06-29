import { describe, expect, it } from "vitest";
import {
  ANDROID_APP_LINK_PACKAGE,
  assetLinksFromEnv,
  buildAssetLinks,
  parseSha256Fingerprints,
} from "./android-asset-links.js";

// A real-shaped 64-hex SHA-256 (not a real key) for the structural assertions.
const FP_A = "AB".repeat(32); // 64 hex chars
const FP_A_COLON = FP_A.match(/.{2}/g)!.join(":");
const FP_B = "CD".repeat(32);
const FP_B_COLON = FP_B.match(/.{2}/g)!.join(":");

describe("parseSha256Fingerprints", () => {
  it("normalizes a colon-hex value (passthrough, uppercased)", () => {
    expect(parseSha256Fingerprints(FP_A_COLON.toLowerCase())).toEqual([FP_A_COLON]);
  });

  it("accepts a separator-less paste (Play console / keytool) and inserts colons", () => {
    expect(parseSha256Fingerprints(FP_A)).toEqual([FP_A_COLON]);
  });

  it("splits comma / space / newline lists and dedupes", () => {
    expect(parseSha256Fingerprints(`${FP_A}, ${FP_B_COLON}\n${FP_A}`)).toEqual([
      FP_A_COLON,
      FP_B_COLON,
    ]);
  });

  it("drops malformed entries (wrong length / non-hex)", () => {
    expect(parseSha256Fingerprints("not-a-fingerprint")).toEqual([]);
    expect(parseSha256Fingerprints("AB:CD:EF")).toEqual([]); // too short
    expect(parseSha256Fingerprints(`${FP_A}, zzz`)).toEqual([FP_A_COLON]);
  });

  it("empty / null → []", () => {
    expect(parseSha256Fingerprints("")).toEqual([]);
    expect(parseSha256Fingerprints(undefined)).toEqual([]);
    expect(parseSha256Fingerprints(null)).toEqual([]);
  });
});

describe("buildAssetLinks", () => {
  it("builds a single statement covering all fingerprints (app-signing + upload key)", () => {
    const out = buildAssetLinks(ANDROID_APP_LINK_PACKAGE, [FP_A_COLON, FP_B_COLON]);
    expect(out).toEqual([
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: "com.cyborg7.mobile",
          sha256_cert_fingerprints: [FP_A_COLON, FP_B_COLON],
        },
      },
    ]);
  });

  it("no fingerprints → null (caller 404s instead of serving a doomed statement)", () => {
    expect(buildAssetLinks(ANDROID_APP_LINK_PACKAGE, [])).toBeNull();
  });

  it("is valid JSON and round-trips", () => {
    const out = buildAssetLinks(ANDROID_APP_LINK_PACKAGE, [FP_A_COLON])!;
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("assetLinksFromEnv (the relay route source)", () => {
  it("DONE repro: a configured fingerprint yields a verifiable statement for com.cyborg7.mobile", () => {
    const out = assetLinksFromEnv(FP_A);
    expect(out).not.toBeNull();
    expect(out![0].target.package_name).toBe("com.cyborg7.mobile");
    expect(out![0].target.sha256_cert_fingerprints).toEqual([FP_A_COLON]);
  });

  it("unset env → null (route returns 404, no bogus file)", () => {
    expect(assetLinksFromEnv(undefined)).toBeNull();
    expect(assetLinksFromEnv("")).toBeNull();
  });
});
