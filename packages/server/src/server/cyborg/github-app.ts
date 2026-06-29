// GitHub App authentication + REST helpers. Mints an installation access token (the
// App-JWT → installation-token exchange) so the receiver/UI can call the GitHub REST
// API on a repo's behalf (e.g. list an installation's repositories for the bind
// picker), and lists those repositories.
//
// This module compiles WITHOUT live App credentials: every live-call path is guarded
// by `isGithubAppConfigured()`. With the secrets ABSENT, `mintInstallationToken`
// returns null and callers degrade gracefully (the UI falls back to manual repo
// entry). The octokit deps are loaded via dynamic `import()` so a bare typecheck
// never depends on them being installed.
//
// GATED ON (all three must be present for live minting):
//   - GITHUB_APP_ID                  — the App's numeric id.
//   - GITHUB_APP_PRIVATE_KEY_B64     — the App's PEM private key, BASE64-encoded
//     (single line). Preferred: a base64 blob survives systemd's EnvironmentFile
//     single-quoting cleanly, whereas a raw multiline PEM does not. Falls back to a
//     raw `GITHUB_APP_PRIVATE_KEY` (PKCS#1 or PKCS#8 PEM) if someone sets that instead.
//   - (per-call) the numeric installation_id, supplied by the caller.
//
// DEPLOY: `@octokit/auth-app` + `@octokit/rest` are listed in packages/server/
// package.json AND in deploy/package.json (the relay manifest) — a missing entry
// there crash-loops the relay on startup.

// The App's PEM private key, read as base64 first (GITHUB_APP_PRIVATE_KEY_B64 →
// decoded to a PEM string) and falling back to a raw PEM (GITHUB_APP_PRIVATE_KEY).
// Returns null when neither is set so callers stay gated. The base64 form is what
// the relay deploy writes (a single-line value survives systemd's EnvironmentFile
// quoting; a multiline PEM does not).
function githubAppPrivateKey(): string | null {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  return raw ?? null;
}

// True only when BOTH App-JWT secrets are present: the App id AND a private key
// (base64 or raw). Every live-App call site checks this first; with it false, the
// feature is inert (no throw, no network).
export function isGithubAppConfigured(): boolean {
  return !!(
    process.env.GITHUB_APP_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY_B64 || process.env.GITHUB_APP_PRIVATE_KEY)
  );
}

// The App's public slug (GITHUB_APP_SLUG, e.g. "cyborg7-tasks"), or null when unset.
// The slug is PUBLIC — it's the identifier in the App's install URL on github.com —
// so it is safe to surface to the UI, which uses it to render the "Connect GitHub"
// button and build the install link. Single source of truth for the env read.
export function getGithubAppSlug(): string | null {
  return process.env.GITHUB_APP_SLUG ?? null;
}

// The public install URL the "Connect GitHub" button redirects to. Slug comes from
// GITHUB_APP_SLUG (the App's public slug). Returns null when unset so the UI can show
// a clear "App not configured" state instead of a broken link.
//
// When `workspaceId` is supplied it is carried in the `state` query param — GitHub
// echoes `state` back to the App's Setup/Callback URL after install, so the callback
// (routes/github.ts) knows which workspace initiated the install and can land the
// user on that workspace's integration detail page.
export function githubAppInstallUrl(workspaceId?: string): string | null {
  const slug = getGithubAppSlug();
  if (!slug) return null;
  const base = `https://github.com/apps/${slug}/installations/new`;
  return workspaceId ? `${base}?state=${encodeURIComponent(workspaceId)}` : base;
}

// Mint an installation access token for a given numeric installation id. GATED:
// returns null (no throw) when the App isn't configured, so callers degrade
// gracefully. Uses @octokit/auth-app's createAppAuth to perform the App-JWT →
// installation-token exchange.
export async function mintInstallationToken(installationId: string): Promise<string | null> {
  if (!isGithubAppConfigured()) return null;

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = githubAppPrivateKey();
  // Guard again for the type-narrowing (isGithubAppConfigured already checked).
  if (!appId || !privateKey) return null;

  try {
    const { createAppAuth } = await import("@octokit/auth-app");
    const auth = createAppAuth({ appId, privateKey });
    const { token } = await auth({ type: "installation", installationId: Number(installationId) });
    return token;
  } catch (err) {
    // Never throw to the caller — a mint failure degrades to manual repo entry.
    console.error(`[github-app] failed to mint installation token for ${installationId}`, err);
    return null;
  }
}

// A repository an installation can access (the bind-picker source). Mirrors
// ws-client's GithubInstallationRepo shape.
export interface GithubInstallationRepoInfo {
  repoId: string;
  owner: string;
  name: string;
  repoUrl: string;
}

// List every repository the given installation can access, via the REST API with an
// installation token (GET /installation/repositories, paginated). GATED: returns []
// (no throw) when the App isn't configured or the token mint / fetch fails, so the UI
// falls back to manual entry.
export async function listInstallationRepos(
  installationId: string,
): Promise<GithubInstallationRepoInfo[]> {
  const token = await mintInstallationToken(installationId);
  if (!token) return [];
  try {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });
    const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return repos
      .map((r) => ({
        repoId: String(r.id),
        owner: r.owner?.login ?? "",
        name: r.name ?? "",
        repoUrl: r.html_url ?? "",
      }))
      .filter((r) => r.owner !== "" && r.name !== "");
  } catch (err) {
    console.error(`[github-app] failed to list installation repos for ${installationId}`, err);
    return [];
  }
}

// The account (login + type) a GitHub App installation belongs to. The bind/connect
// flow records this so the UI can show "<org> connected".
export interface GithubInstallationAccount {
  login: string;
  type: string; // "User" | "Organization"
}

// Fetch the account a numeric installation id belongs to, via the App-JWT
// (GET /app/installations/{id}). GATED: returns null (no throw) when the App isn't
// configured or the fetch fails. The install-confirm callback uses it both to LEARN
// the account login for display AND to VERIFY the installation actually exists before
// recording a github_installations row — so a guessed/foreign installation id (the ids
// are low-entropy sequential ints) can't mint a bogus row. Uses the App-JWT auth
// strategy (NOT an installation token): getInstallation is an app-authed endpoint.
export async function getInstallationAccount(
  installationId: string,
): Promise<GithubInstallationAccount | null> {
  if (!isGithubAppConfigured()) return null;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = githubAppPrivateKey();
  if (!appId || !privateKey) return null;
  try {
    const { createAppAuth } = await import("@octokit/auth-app");
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const { data } = await octokit.rest.apps.getInstallation({
      installation_id: Number(installationId),
    });
    // `account` is a User | Organization | Enterprise | null; only User/Org carry a login.
    const account = data.account as { login?: string; type?: string } | null;
    const login = account?.login?.trim() ?? "";
    if (!login) return null;
    return { login, type: account?.type?.trim() || "User" };
  } catch (err) {
    console.error(`[github-app] failed to fetch installation account for ${installationId}`, err);
    return null;
  }
}

// ─── Personal-account OAuth (distinct from the App install) ──────────────────
// The "Connect Personal Account" flow uses a classic OAuth App (its own
// client_id/secret), NOT the GitHub App's JWT. Gated on both env vars so the UI can
// render a clear "not configured" state when they're absent.

// True only when BOTH OAuth secrets are present.
export function isGithubOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

// The OAuth App's public client id (used to build the authorize URL), or null.
export function getGithubOAuthClientId(): string | null {
  return process.env.GITHUB_OAUTH_CLIENT_ID ?? null;
}

// The OAuth App's client secret (used server-side for the code → token exchange), or
// null. NEVER surfaced to a client.
export function getGithubOAuthClientSecret(): string | null {
  return process.env.GITHUB_OAUTH_CLIENT_SECRET ?? null;
}
