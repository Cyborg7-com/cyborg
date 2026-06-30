// Slack app config + credential gate. Mirrors github-app.ts: every Slack feature
// (the Events endpoint, OAuth, outbound posting) checks `isSlackConfigured()`
// first; with the secrets ABSENT the feature is inert (no throw, no network) and
// the UI renders a clear "not configured" state. WAVE 1 defines only the env reads
// + the gate; the routes that consume them ship in WAVE 2.
//
// GATED ON (all four present for a live, end-to-end Slack integration):
//   - SLACK_CLIENT_ID      — the app's OAuth client id (public; build authorize URL).
//   - SLACK_CLIENT_SECRET  — the app's OAuth client secret (server-side code→token).
//   - SLACK_SIGNING_SECRET — the signing secret for inbound webhook HMAC v0 verify.
//   - SLACK_APP_ID         — the app's id (echo-guard / app-level checks).

// True only when ALL FOUR Slack secrets are present. The Events receiver, OAuth
// install/callback, and outbound poster check this first; with it false the Slack
// integration is inert.
export function isSlackConfigured(): boolean {
  return !!(
    process.env.SLACK_CLIENT_ID &&
    process.env.SLACK_CLIENT_SECRET &&
    process.env.SLACK_SIGNING_SECRET &&
    process.env.SLACK_APP_ID
  );
}

// The OAuth client id (public — used to build the authorize URL), or null.
export function getSlackClientId(): string | null {
  return process.env.SLACK_CLIENT_ID ?? null;
}

// The OAuth client secret (server-side only, for the code → token exchange), or
// null. NEVER surfaced to a client.
export function getSlackClientSecret(): string | null {
  return process.env.SLACK_CLIENT_SECRET ?? null;
}

// The signing secret used to verify inbound Slack webhooks (HMAC v0), or null.
// NEVER surfaced to a client. Passed into slackAdapter.verifyWebhook by the route.
export function getSlackSigningSecret(): string | null {
  return process.env.SLACK_SIGNING_SECRET ?? null;
}

// The Slack app id (used by the echo guard / app-level checks), or null.
export function getSlackAppId(): string | null {
  return process.env.SLACK_APP_ID ?? null;
}
