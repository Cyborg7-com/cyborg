// Exact scheme+host origin check, shared by the Electron main process's
// will-navigate guard and the daemon-control IPC gate (issue #241). Kept as a
// pure, exported function so it's unit-testable and validated identically in
// both places.
//
// We key on `${protocol}//${host}` rather than `URL.origin` because the custom
// `cyborg:` scheme has an opaque ("null") WHATWG origin in Node — `URL.origin`
// equality would collapse every `cyborg://*` host to the same value and accept
// a spoofed host like `cyborg://app.evil`.
const APP_ORIGIN = "cyborg://app";

function originKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// True only when `rawUrl`'s scheme+host exactly matches the packaged app origin
// (`cyborg://app`) or the dev server origin. Unparseable input is rejected.
export function isTrustedAppOrigin(
  rawUrl: string,
  devUrl: string = process.env.CYBORG7_DEV_URL ?? "http://localhost:5173",
): boolean {
  const key = originKey(rawUrl);
  if (key === null) return false;
  return key === APP_ORIGIN || key === originKey(devUrl);
}
