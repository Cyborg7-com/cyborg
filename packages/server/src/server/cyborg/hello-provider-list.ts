// Honest daemon_hello provider list (FIX 2, internal docs).
//
// THE BUG: daemon_hello.providers is the provider-snapshot's READY ids, and a
// native harness's "ready" bottoms out on Paseo's binary-only isAvailable() — it
// does NOT check the host LOGIN. So a daemon with `claude`/`codex` installed but
// SIGNED OUT still advertises "claude" in its hello. The relay's pickMentionDaemon
// then treats it as capable and routes a native cybo to it, mentionCapabilityGap
// never fires, and the spawn auth-fails into the silent ephemeral-drain black hole.
//
// THE FIX (cyborg-side only — Paseo's snapshot manager is untouched): post-filter
// the native harness ids in the hello through the SAME read-only probeNativeHarnessLogin
// the dispatcher's list_providers already uses, dropping a native id only when the
// probe says logged_out. logged_in / unknown keep it (fail-open — a real auth gap
// still surfaces at turn time). With a logged-out native id removed, the relay's
// pickMentionDaemon skips this daemon and the capability-gap notice fires correctly.
//
// The probe is read-only + 10s-cached, so refreshing on the existing 60s
// runtime-profile timer is cheap.

import { isNativeHarnessProvider, probeNativeHarnessLogin } from "./native-harness-login.js";

// Compute the set of native harness ids that are present in `readyProviders` but
// currently SIGNED OUT on this host, so the hello getter can drop them. Native ids
// that are logged_in / unknown (probe failed) are NOT included — fail-open.
export async function computeLoggedOutNativeProviders(
  readyProviders: readonly string[],
): Promise<Set<string>> {
  const loggedOut = new Set<string>();
  const natives = readyProviders.filter(isNativeHarnessProvider);
  await Promise.all(
    natives.map(async (provider) => {
      try {
        const login = await probeNativeHarnessLogin(provider);
        if (login.state === "logged_out") loggedOut.add(provider);
      } catch {
        // Probe failure ⇒ fail-open: keep advertising the provider (today's
        // binary-only behavior). A real auth gap still surfaces at turn time.
      }
    }),
  );
  return loggedOut;
}

// Filter a ready-provider list down to the ids the daemon should HONESTLY
// advertise in daemon_hello: every ready id minus the native ids known to be
// signed out. Pure + synchronous so the hello getter stays a cheap cache read.
export function honestHelloProviders(
  readyProviders: readonly string[],
  loggedOutNative: ReadonlySet<string>,
): string[] {
  return readyProviders.filter((id) => !loggedOutNative.has(id));
}
