// Usage-metrics (round 1): the daemon publishes its deployment "edition" on
// hello + every heartbeat. The value is resolved ONCE at boot — explicit env
// beats inferred — and this pure helper holds that resolution so it can be
// unit-tested apart from the bootstrap IIFE that wires it.

export type DaemonEdition = "saas" | "selfhost" | "opensource";

/**
 * Resolve the daemon's deployment edition.
 *
 *   1. CYBORG_EDITION env, if one of the three known values → verbatim.
 *   2. else solo storage → 'opensource'.
 *   3. else the canonical SaaS relay on connected (cloud) storage → 'saas';
 *      any other configured relay (a custom/self-hosted relay) → 'selfhost'.
 *
 * `relayHost` is the host only (no port); the caller strips the port before
 * passing it in.
 */
export function resolveDaemonEdition(opts: {
  envEdition: string | undefined; // process.env.CYBORG_EDITION
  relayHost: string; // host only, no port
  storageMode: "solo" | "connected";
}): DaemonEdition {
  const explicit = opts.envEdition?.trim();
  if (explicit === "saas" || explicit === "selfhost" || explicit === "opensource") {
    return explicit;
  }
  if (opts.storageMode === "solo") return "opensource";
  return opts.relayHost === "relay.cyborg7.com" && opts.storageMode === "connected"
    ? "saas"
    : "selfhost";
}
