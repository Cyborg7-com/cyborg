// WebAuthn / passkey browser ceremonies. Thin wrappers over @simplewebauthn/
// browser that talk to the relay's /api/auth/passkey/* endpoints. The login
// ceremony is pre-auth (no token); register/list/delete are authenticated and
// driven from CyborgClient (which injects the relay base + bearer token).

import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export function passkeySupported(): boolean {
  return browserSupportsWebAuthn();
}

export function passkeyAutofillSupported(): Promise<boolean> {
  return browserSupportsWebAuthnAutofill();
}

export interface PasskeySession {
  token: string;
  user: { id: string; email: string; name: string | null };
  workspaces: { id: string; name: string; role: string }[];
}

export interface PasskeyInfo {
  id: string;
  nickname: string | null;
  deviceType: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

async function readError(resp: Response, fallback: string): Promise<string> {
  const body = (await resp.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

// Passwordless login against `httpBase` (cloud relay or a self-hosted relay).
// Returns the same session payload as POST /api/auth/login. `conditional`
// drives the in-field autofill UX (browser shows the passkey in the email
// field's dropdown); pass a signal so the caller can cancel it.
export async function passkeyAuthenticate(
  httpBase: string,
  opts: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<PasskeySession> {
  const optResp = await fetch(`${httpBase}/api/auth/passkey/auth/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: opts.signal,
  });
  if (!optResp.ok) throw new Error(await readError(optResp, "Passkeys are unavailable here"));
  const { options, challengeKey } = (await optResp.json()) as {
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeKey: string;
  };

  const response = await startAuthentication({
    optionsJSON: options,
    useBrowserAutofill: opts.conditional ?? false,
  });

  const verifyResp = await fetch(`${httpBase}/api/auth/passkey/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response, challengeKey }),
  });
  if (!verifyResp.ok) throw new Error(await readError(verifyResp, "Passkey sign-in failed"));
  return verifyResp.json() as Promise<PasskeySession>;
}

// Register a new passkey for the already-authenticated user.
export async function passkeyRegister(
  httpBase: string,
  token: string,
  nickname?: string,
): Promise<void> {
  const optResp = await fetch(`${httpBase}/api/auth/passkey/register/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
  });
  if (!optResp.ok) throw new Error(await readError(optResp, "Couldn't start passkey setup"));
  const options = (await optResp.json()) as PublicKeyCredentialCreationOptionsJSON;

  const response = await startRegistration({ optionsJSON: options });

  const verifyResp = await fetch(`${httpBase}/api/auth/passkey/register/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ response, nickname }),
  });
  if (!verifyResp.ok) throw new Error(await readError(verifyResp, "Couldn't save passkey"));
}

export async function passkeyList(httpBase: string, token: string): Promise<PasskeyInfo[]> {
  const resp = await fetch(`${httpBase}/api/auth/passkey/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(await readError(resp, "Couldn't load passkeys"));
  const body = (await resp.json()) as { passkeys: PasskeyInfo[] };
  return body.passkeys;
}

export async function passkeyDelete(httpBase: string, token: string, id: string): Promise<void> {
  const resp = await fetch(`${httpBase}/api/auth/passkey/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(await readError(resp, "Couldn't remove passkey"));
}
