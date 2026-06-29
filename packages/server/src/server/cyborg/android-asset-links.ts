// Android App Links (Digital Asset Links) for app.cyborg7.com.
//
// tauri.conf.json declares the mobile deep-link host, which makes the Tauri
// deep-link plugin emit an <intent-filter android:autoVerify="true"> for that
// https host in the generated Android manifest. Android then verifies the link
// by fetching https://<host>/.well-known/assetlinks.json and matching the app's
// package + signing-cert SHA-256. The host IS app.cyborg7.com (the real app
// origin — invite/workspace links live there and the relay already serves it),
// NOT the marketing root cyborg7.com.
//
// The relay (which serves app.cyborg7.com) must answer
// /.well-known/assetlinks.json with application/json — otherwise the SPA
// fallback returns the HTML shell and verification fails. The signing-cert
// fingerprints are DEPLOY SECRETS (Play app-signing cert + upload key), so they
// come from env, not a committed literal.

export const ANDROID_APP_LINK_PACKAGE = "com.cyborg7.mobile";

export interface AssetLinkStatement {
  relation: string[];
  target: {
    namespace: "android_app";
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

// Parse env-supplied fingerprints: comma/space/newline-separated, normalized to
// the colon-hex uppercase form Android expects (AB:CD:…). Tolerates a pasted
// `keytool`/Play-console value with or without separators. Invalid entries drop.
export function parseSha256Fingerprints(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,]+/)) {
    const hex = tok.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (hex.length !== 64) continue; // SHA-256 = 32 bytes = 64 hex chars
    const colon = hex.match(/.{2}/g)!.join(":");
    if (!seen.has(colon)) {
      seen.add(colon);
      out.push(colon);
    }
  }
  return out;
}

// Build the assetlinks.json body. One statement (handle_all_urls +
// get_login_creds) covering every supplied fingerprint, so a build signed by
// EITHER the Play app-signing cert OR the upload key verifies. Returns null when
// there are no valid fingerprints — the caller should then 404 rather than
// serve a statement that would silently fail verification.
export function buildAssetLinks(
  packageName: string,
  fingerprints: readonly string[],
): AssetLinkStatement[] | null {
  if (fingerprints.length === 0) return null;
  return [
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}

// Convenience: the full statement list straight from env, or null.
export function assetLinksFromEnv(
  rawFingerprints: string | undefined | null,
  packageName: string = ANDROID_APP_LINK_PACKAGE,
): AssetLinkStatement[] | null {
  return buildAssetLinks(packageName, parseSha256Fingerprints(rawFingerprints));
}
