<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    client,
    connectToServer,
    acceptInvitation,
    getInvitePreview,
    getSavedSession,
    AuthError,
    type PublicInvitePreview,
  } from "$lib/state/app.svelte.js";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import { isDesktopApp } from "$lib/utils.js";

  // Canonical Cyborg Cloud relay (TLS via the ALB) — the fallback when there's
  // no saved session to derive the relay origin from (a logged-out invitee
  // opening the link for the first time). Mirrors login/+page.svelte's CLOUD_SERVER.
  const CLOUD_WS_URL = "wss://relay.cyborg7.com/api/ws";

  const token = $derived(page.params.token ?? "");

  type Phase = "loading" | "ready" | "accepting" | "needs_login" | "error" | "done";

  let phase = $state<Phase>("loading");
  let preview = $state<PublicInvitePreview | null>(null);
  let message = $state("");
  // The ws url we resolved the preview against — reused for the connect+accept
  // so the landing page and the redemption hit the same relay.
  let wsUrl = $state(CLOUD_WS_URL);

  // Resolve the relay ws url from the saved session if present (covers self-
  // hosted), else fall back to the cloud relay.
  function resolveWsUrl(): string {
    const saved = getSavedSession();
    return saved?.url ?? CLOUD_WS_URL;
  }

  // Run the preview + connect/accept exactly once per token. This effect can
  // re-fire as `page` settles during hydration; without this guard a second run
  // calls connectToServer() again, tearing down the first socket mid-auth and
  // churning the connection until the relay drops it as an unauthenticated guest
  // ("auth timeout") — which surfaced as a spurious "Can't reach the server".
  let handledToken = "";

  $effect(() => {
    const t = token;
    if (!t) {
      phase = "error";
      message = "This invitation link is invalid.";
      return;
    }
    if (t === handledToken) return;
    handledToken = t;
    void load(t);
  });

  async function load(t: string): Promise<void> {
    phase = "loading";
    message = "";
    wsUrl = resolveWsUrl();
    let p: PublicInvitePreview;
    try {
      p = await getInvitePreview(wsUrl, t);
    } catch {
      phase = "error";
      message = "Couldn't load this invitation. Please try again.";
      return;
    }
    preview = p;

    if (p.status === "expired") {
      phase = "error";
      message = "This invitation has expired. Ask the workspace owner to send a new one.";
      return;
    }
    if (p.status === "accepted") {
      phase = "error";
      message = "This invitation has already been accepted.";
      return;
    }
    if (p.status === "invalid" || !p.workspace) {
      phase = "error";
      message = "This invitation link is invalid.";
      return;
    }

    // Pending. If the user already has a session, connect + accept right away;
    // otherwise prompt them to sign in (preserving the invite as the return URL).
    const saved = getSavedSession();
    if (saved) {
      await connectAndAccept(saved.url, saved.token, t);
    } else {
      phase = "needs_login";
    }
  }

  async function connectAndAccept(url: string, sessionToken: string, t: string): Promise<void> {
    phase = "accepting";
    message = "";
    // Reuse an already-authenticated socket (the user has the app open in this
    // tab) rather than reconnecting — a redundant connect() would tear down the
    // live socket. When there's no connection yet (a fresh tab opened straight
    // to the invite link), establish one, retrying transient relay outages
    // (deploy / cold start) so a single blip doesn't strand the invitee on the
    // error screen. Mirrors the workspace restore flow.
    if (!(client.connected && client.authenticated)) {
      let attempt = 0;
      for (;;) {
        try {
          await connectToServer(url, sessionToken);
          break;
        } catch (e) {
          // The token changed (navigated to a different invite) while a retry was
          // pending — abandon this stale loop so it can't clobber phase state or
          // accept the wrong invitation.
          if (t !== token) return;
          if (e instanceof AuthError) {
            // Saved session is stale/expired — fall back to signing in.
            phase = "needs_login";
            return;
          }
          attempt += 1;
          if (attempt >= 5) {
            phase = "error";
            message = "Can't reach the server. It may be updating — try again in a moment.";
            return;
          }
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
        }
      }
    }

    try {
      const workspaceId = await acceptInvitation(t);
      phase = "done";
      // Web users get the skippable "download the desktop app" gate first;
      // desktop users are already in the app, so go straight to the workspace.
      if (isDesktopApp()) {
        goto(`/workspace/${workspaceId}`);
      } else {
        goto(`/welcome/download?next=${encodeURIComponent(`/workspace/${workspaceId}`)}`);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Couldn't accept this invitation.";
      // Email mismatch: signed in as a different account than the one invited.
      if (/mismatch|invited as|different email|wrong email/i.test(raw)) {
        const invited = preview?.invitedEmail;
        phase = "error";
        message = invited
          ? `This invitation was sent to ${invited}. You're signed in as a different account — sign in with the invited email to join.`
          : "This invitation was sent to a different email. Sign in with the invited email to join.";
        return;
      }
      if (/expired/i.test(raw)) {
        phase = "error";
        message = "This invitation has expired. Ask the workspace owner to send a new one.";
        return;
      }
      if (/already.*accept|accepted/i.test(raw)) {
        phase = "error";
        message = "This invitation has already been accepted.";
        return;
      }
      phase = "error";
      message = raw;
    }
  }

  function goToLogin(): void {
    goto(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const workspaceName = $derived(preview?.workspace?.name ?? "this workspace");
</script>

<div class="auth-shell relative isolate flex h-full items-center justify-center overflow-hidden bg-surface p-4">
  <div class="auth-veil-top" aria-hidden="true"></div>
  <div class="auth-glow" aria-hidden="true"></div>
  <div class="auth-glow-hot" aria-hidden="true"></div>

  <div class="relative z-10 flex w-full items-center justify-center">
    <div class="w-full max-w-sm rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm">
      <div class="space-y-5 text-center">
        <CyborgIcon size={28} class="mx-auto text-accent" />

        {#if phase === "loading"}
          <div class="flex items-center justify-center gap-3 py-2 text-sm text-content-muted">
            <div class="h-4 w-4 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
            <span>Loading invitation…</span>
          </div>
        {:else if phase === "accepting" || phase === "done"}
          <div class="space-y-2">
            <h1 class="text-lg font-bold text-content">Joining {workspaceName}…</h1>
            <div class="flex items-center justify-center gap-3 py-1 text-sm text-content-muted">
              <div class="h-4 w-4 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
              <span>One moment</span>
            </div>
          </div>
        {:else if phase === "needs_login"}
          <div class="space-y-2">
            <h1 class="text-lg font-bold text-content">Sign in to join {workspaceName}</h1>
            {#if preview?.invitedEmail}
              <p class="text-sm text-content-dim">
                Invitation sent to
                <span class="font-medium text-content">{preview.invitedEmail}</span>.
                Sign in with this email to accept.
              </p>
            {:else}
              <p class="text-sm text-content-dim">Sign in to accept this invitation.</p>
            {/if}
          </div>
          <button
            type="button"
            onclick={goToLogin}
            class="w-full rounded-lg bg-btn-primary-bg py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
          >
            Sign in to continue
          </button>
        {:else if phase === "error"}
          <div class="space-y-2">
            <h1 class="text-lg font-bold text-content">Invitation</h1>
            <p class="text-sm text-error">{message}</p>
          </div>
          <button
            type="button"
            onclick={() => goto("/workspace")}
            class="w-full rounded-lg border border-edge py-2 text-sm font-medium text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            Go to Cyborg
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* Decorative accent glow — ported from the auth screens (login/+page.svelte)
     so the invite landing matches the sign-in look. Layers are pointer-events:none
     and aria-hidden. */
  .auth-veil-top,
  .auth-glow,
  .auth-glow-hot {
    position: absolute;
    pointer-events: none;
    z-index: 0;
  }

  .auth-veil-top {
    inset: 0;
    background: linear-gradient(
      to bottom,
      var(--color-surface) 0%,
      color-mix(in oklch, var(--color-surface) 85%, transparent) 35%,
      transparent 70%
    );
  }

  .auth-glow {
    left: 50%;
    bottom: -25%;
    transform: translateX(-50%);
    width: 180%;
    max-width: 1800px;
    aspect-ratio: 3 / 2;
    opacity: 0.35;
    background: radial-gradient(
      ellipse at 50% 70%,
      color-mix(in oklch, var(--color-accent) 28%, transparent) 0%,
      color-mix(in oklch, var(--color-accent) 14%, transparent) 24%,
      color-mix(in oklch, var(--color-accent) 5%, transparent) 50%,
      transparent 75%
    );
    filter: blur(60px);
  }

  .auth-glow-hot {
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: 80%;
    max-width: 900px;
    aspect-ratio: 2 / 1;
    opacity: 0.28;
    background: radial-gradient(
      ellipse at 50% 80%,
      color-mix(in oklch, var(--color-accent) 45%, transparent) 0%,
      color-mix(in oklch, var(--color-accent) 18%, transparent) 30%,
      transparent 65%
    );
    filter: blur(70px);
  }

  :global([data-theme="dark"]) .auth-glow {
    opacity: 1;
    filter: blur(40px);
    background: radial-gradient(
      ellipse at 50% 65%,
      color-mix(in oklch, var(--color-accent) 70%, transparent) 0%,
      color-mix(in oklch, var(--color-accent) 40%, transparent) 18%,
      color-mix(in oklch, var(--color-accent) 15%, transparent) 42%,
      transparent 78%
    );
  }

  :global([data-theme="dark"]) .auth-glow-hot {
    opacity: 0.5;
  }
</style>
