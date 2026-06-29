<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount, tick } from "svelte";
  import { slide, fade, fly, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { page } from "$app/state";
  import {
    connectToServer,
    getSavedSession,
    clearSavedSession,
    AuthError,
  } from "$lib/state/app.svelte.js";
  import { isTauriIOS } from "$lib/mobile/push";
  import { haptic } from "$lib/mobile/haptics";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import OtpInput from "$lib/components/auth/OtpInput.svelte";
  import {
    passkeyAuthenticate,
    passkeySupported,
    passkeyAutofillSupported,
  } from "$lib/passkey";
  import { Eye, EyeOff, Fingerprint } from "@lucide/svelte";

  // iOS keyboard fix (v1 login/+page.svelte parity). The native push layer pins
  // WKWebView's outer scroll to zero (so iOS's auto-scroll can't fight our
  // visualViewport keyboard handling), which means iOS can't auto-scroll a
  // focused web input into view — the lower login/OTP fields get covered by the
  // keyboard. Manually center the focused input on focus. iOS-gated only, so
  // web/desktop/Android are untouched.
  onMount(() => {
    if (!isTauriIOS()) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") return;
      // Wait a frame so the visualViewport has settled after the keyboard
      // animation begins, then center the focused input in the visible area.
      setTimeout(() => target.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  });

  type Step = "mode" | "auth" | "otp" | "forgot" | "reset";
  type Mode = "cloud" | "selfhost";
  type AuthMode = "login" | "register";

  // Public cloud relay over TLS — a load balancer terminates HTTPS/WSS and
  // proxies to the relay backend. The client derives wss:// from this
  // automatically.
  const CLOUD_SERVER = "https://relay.cyborg7.com";

  // ── Dev/localhost default → LOCAL relay ─────────────────────────────────────
  // When the UI is served from a developer's machine in DEV (vite dev / local
  // Docker stack on localhost:5173), default the login form to the LOCAL relay so
  // a `pnpm dev` session can't silently authenticate against the CLOUD relay
  // (relay.cyborg7.com). Production (any non-localhost host) and the desktop build
  // are completely unaffected: `isDevLocalhost` is false there, so `mode` stays
  // "cloud" and `serverUrl` stays "" exactly as before. The local relay URL is
  // configurable via VITE_LOCAL_RELAY_URL, defaulting to the Docker stack's port.
  const isDevLocalhost =
    import.meta.env.DEV &&
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  const LOCAL_RELAY_URL =
    (import.meta.env.VITE_LOCAL_RELAY_URL as string | undefined) ?? "http://localhost:9100";
  const inputCls =
    "h-9 w-full rounded-lg border border-edge bg-transparent px-3 py-1 text-sm text-content outline-none placeholder:text-content-muted focus:border-accent focus:ring-[3px] focus:ring-accent/25 transition-[border-color,box-shadow]";

  // ── Mobile presentation classes (P1 iOS redesign) ──────────────────────────
  // CRITICAL: inputs keep a ≥16px font-size — anything smaller makes iOS
  // WKWebView zoom the viewport on focus. 50pt height + 12px radius per the
  // redesign spec; semantic tokens only so both themes hold. Explicit px for
  // sizes/radii: the root font-size is 15px and --radius-xl is shadcn-derived,
  // so rem-based utilities (h-12, rounded-xl) don't land on the spec values.
  const mobileInputCls =
    "h-[50px] w-full rounded-[12px] border border-edge bg-surface-alt px-4 text-[16px] text-content outline-none transition-colors placeholder:text-content-muted focus:border-edge-light";
  const mobileLabelCls = "mb-1.5 block text-[13px] font-medium text-content-dim";
  const mobileCtaCls =
    "pressable h-[50px] w-full rounded-[12px] bg-btn-primary-bg text-[17px] font-semibold text-btn-primary-text disabled:cursor-not-allowed disabled:opacity-40";
  const mobileBackBtnCls =
    "pressable -ml-2 mt-2 flex h-[44px] w-[44px] items-center justify-center rounded-full text-content-dim";

  let step: Step = $state("mode");
  // Dev/localhost defaults to the self-host card pre-filled with the LOCAL relay
  // (see isDevLocalhost above); prod/desktop keep the original cloud default. This
  // is the INITIAL choice only — picking a hosting card / toggling overrides it.
  let mode: Mode = $state(isDevLocalhost ? "selfhost" : "cloud");
  let authMode: AuthMode = $state("login");
  let serverUrl = $state(isDevLocalhost ? LOCAL_RELAY_URL : "");
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let confirmPassword = $state("");
  let error = $state("");
  let connecting = $state(false);
  let otpCode = $state("");
  // Populated only when the relay runs in dev mode (no Resend key): it returns
  // the code so signup works without an inbox. Never set in production.
  let devCodeHint = $state("");
  let info = $state(""); // success/info banner (e.g. "code resent")
  let newPassword = $state("");
  let confirmNewPassword = $state("");
  // Password reveal toggles (figma onboarding redesign — eye affordance on the
  // password fields). Presentation-only; never persisted.
  let showPassword = $state(false);
  let showConfirmPassword = $state(false);
  // Resend cooldown countdown (seconds). Disables the resend button + reflects
  // the server's anti-email-bomb window so we never spam the inbox.
  let cooldown = $state(0);
  let cooldownTimer: ReturnType<typeof setInterval> | undefined;

  function startCooldown(seconds = 30) {
    cooldown = seconds;
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0) clearInterval(cooldownTimer);
    }, 1000);
  }

  // ── Mobile-only presentation state (P1 iOS redesign) ───────────────────────
  // Progressive disclosure: the phone layout shows email + "Continue" first,
  // then reveals the credential fields. These gate VISIBILITY only — every
  // submit still goes through the untouched handleAuth()/verifyOtp()/reset
  // handlers and their existing validation + error states. On mobile the
  // cloud/self-host choice (desktop step "mode") is demoted to an "Advanced"
  // toggle, so steps "mode" and "auth" render the same welcome screen.
  let detailsRevealed = $state(false);

  function setAuthModeMobile(m: AuthMode) {
    if (authMode === m) return;
    authMode = m;
    error = "";
    haptic("selection");
  }

  // Stage 1 "Continue": reuse handleAuth's own checks (same messages, same
  // order) for everything visible at this stage, then reveal the rest of the
  // form and move focus to the first new field.
  async function mobileContinue() {
    if (!detailsRevealed) {
      error = "";
      if (mode === "selfhost" && !serverUrl) {
        error = "Server URL required";
        return;
      }
      if (!email) {
        error = "Email required";
        return;
      }
      detailsRevealed = true;
      await tick();
      document.getElementById(authMode === "register" ? "name" : "password")?.focus();
      return;
    }
    await handleAuth();
  }

  // "Advanced: self-hosted server" — same mode/serverUrl logic as the desktop
  // hosting cards (selectMode), minus the step change.
  function toggleSelfHost() {
    error = "";
    if (mode === "selfhost") {
      mode = "cloud";
    } else {
      mode = "selfhost";
      // Dev/localhost: re-fill the LOCAL relay so the toggle lands ready-to-go;
      // prod/desktop blank it as before so the user types their own server URL.
      serverUrl = isDevLocalhost ? LOCAL_RELAY_URL : "";
    }
  }

  const autoToken = page.url.searchParams.get("token");
  const autoServer = page.url.searchParams.get("server");
  // Post-login destination. The invite landing page sends users here with
  // ?next=/invite/<token> so a successful sign-in resumes the accept flow
  // instead of dumping them on the workspace list. Restricted to same-origin
  // paths (must start with "/") so it can't be used as an open redirect.
  const rawNext = page.url.searchParams.get("next");
  const nextDest = rawNext && rawNext.startsWith("/") ? rawNext : null;

  function goAfterLogin(): void {
    goto(nextDest ?? "/workspace");
  }

  // ── Passkeys / WebAuthn ─────────────────────────────────────────
  const hasPasskeys = passkeySupported();

  // Explicit "Continue with passkey" — passwordless login via the platform
  // authenticator (Touch ID / Face ID / security key).
  async function loginWithPasskey() {
    error = "";
    connecting = true;
    try {
      const session = await passkeyAuthenticate(getBaseUrl());
      await connectToServer(getWsUrl(), session.token);
      goAfterLogin();
    } catch (e) {
      // A user-cancelled WebAuthn prompt throws NotAllowedError/AbortError —
      // not something to surface as an error; only show genuine failures.
      const name = e instanceof Error ? e.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        error = e instanceof Error ? e.message : "Passkey sign-in failed";
      }
    } finally {
      connecting = false;
    }
  }

  // In-field passkey autofill (conditional mediation): on the login step the
  // browser surfaces any saved passkey inside the email field's dropdown, and
  // choosing it logs in. Requires the email input (autocomplete "...webauthn")
  // to be mounted, so it's scoped to the auth step and torn down on leave.
  $effect(() => {
    if (step !== "auth" || !hasPasskeys) return;
    let cancelled = false;
    const ac = new AbortController();
    void (async () => {
      if (!(await passkeyAutofillSupported())) return;
      try {
        const session = await passkeyAuthenticate(getBaseUrl(), {
          conditional: true,
          signal: ac.signal,
        });
        if (cancelled) return;
        await connectToServer(getWsUrl(), session.token);
        goAfterLogin();
      } catch (err) {
        // Conditional autofill cancellation / no-credential is expected.
        void err;
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  });

  $effect(() => {
    if (autoToken && autoServer) {
      reconnect(autoServer, autoToken);
      return;
    }
    const saved = getSavedSession();
    if (!saved) return;
    reconnect(saved.url, saved.token);
  });

  async function reconnect(url: string, token: string) {
    connecting = true;
    try {
      await connectToServer(url, token);
      goAfterLogin();
    } catch (e) {
      // Only drop the saved session on a genuine auth failure. If the relay is
      // just unreachable (down/deploying), keep the session so the user can
      // retry without re-entering credentials — don't silently wipe it.
      if (e instanceof AuthError) {
        clearSavedSession();
      } else {
        error = "Can't reach the server. It may be updating — try again in a moment.";
      }
      connecting = false;
    }
  }

  function getBaseUrl(): string {
    if (mode === "cloud") return CLOUD_SERVER;
    return serverUrl.replace(/\/$/, "");
  }

  function getWsUrl(): string {
    const base = getBaseUrl();
    const protocol = base.startsWith("https") ? "wss" : "ws";
    const host = base.replace(/^https?:\/\//, "");
    return `${protocol}://${host}/api/ws`;
  }

  function selectMode(m: Mode) {
    mode = m;
    error = "";
    // Dev/localhost: pre-fill the LOCAL relay so the self-host card opens ready to
    // log into the local Docker stack; prod/desktop blank it (type your own URL).
    if (m === "selfhost") serverUrl = isDevLocalhost ? LOCAL_RELAY_URL : "";
    step = "auth";
  }

  // ── Onboarding motion (presentation-only, desktop hosting picker) ───────────
  // Gated on the OS reduced-motion setting so we never animate for users who
  // asked not to; every animation below collapses to duration 0 / no transform
  // when `reduced` is true.
  let reduced = $state(false);
  // Selection-delay timer (see chooseMode). Cleared on unmount so a pending
  // advance never fires state updates on a destroyed component.
  let chooseTimeout: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (reduced = e.matches);
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      if (chooseTimeout) clearTimeout(chooseTimeout);
    };
  });

  // Hosting-card selection: briefly highlight the chosen card (lift + accent
  // ring) and dim the other before advancing to the auth step, so the choice
  // registers before the view changes. Reduced-motion advances immediately.
  let chosen: Mode | null = $state(null);
  function chooseMode(m: Mode) {
    if (chosen) return;
    if (reduced) {
      selectMode(m);
      return;
    }
    chosen = m;
    chooseTimeout = setTimeout(() => {
      selectMode(m);
      chosen = null;
    }, 240);
  }

  function goBack() {
    error = "";
    info = "";
    if (step === "otp" || step === "forgot") step = "auth";
    else if (step === "reset") step = "forgot";
    else step = "mode";
  }

  async function handleAuth() {
    error = "";
    if (mode === "selfhost" && !serverUrl) {
      error = "Server URL required";
      return;
    }
    if (!email) {
      error = "Email required";
      return;
    }
    if (!password) {
      error = "Password required";
      return;
    }
    if (authMode === "register") {
      if (!name) {
        error = "Name required";
        return;
      }
      if (password.length < 6) {
        error = "Password must be at least 6 characters";
        return;
      }
      if (password !== confirmPassword) {
        error = "Passwords don't match";
        return;
      }
    }

    connecting = true;
    try {
      const base = getBaseUrl();
      if (authMode === "register") {
        // Step 1: request a verification code. The account is only created
        // after the OTP is verified in verifyOtp().
        const resp = await fetch(`${base}/api/auth/register/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
          throw new Error(data.error || "Request failed");
        }
        const data = await resp.json();
        devCodeHint = typeof data.devCode === "string" ? data.devCode : "";
        otpCode = "";
        step = "otp";
        return;
      }

      const resp = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(data.error || "Request failed");
      }
      const { token } = await resp.json();
      await connectToServer(getWsUrl(), token);
      goAfterLogin();
    } catch (e) {
      error = e instanceof Error ? e.message : "Connection failed";
    } finally {
      connecting = false;
    }
  }

  // Step 2 of signup: verify the 6-digit code, then create the session and go
  // through first-run onboarding (name the auto-created workspace, set a logo).
  async function verifyOtp() {
    error = "";
    if (!/^\d{6}$/.test(otpCode)) {
      error = "Enter the 6-digit code";
      return;
    }
    connecting = true;
    try {
      const base = getBaseUrl();
      const resp = await fetch(`${base}/api/auth/register/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otpCode }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(data.error || "Verification failed");
      }
      const { token } = await resp.json();
      await connectToServer(getWsUrl(), token);
      // A fresh signup normally goes through first-run onboarding; if they
      // arrived from an invite link (?next=/invite/…), resume that instead so
      // they land in the workspace they were invited to.
      goto(nextDest ?? "/onboarding");
    } catch (e) {
      error = e instanceof Error ? e.message : "Verification failed";
    } finally {
      connecting = false;
    }
  }

  // Resend the signup code via the dedicated endpoint (no form re-submit), with
  // a client cooldown mirroring the server's. `purpose` picks signup vs reset.
  async function resendCode(purpose: "signup" | "reset") {
    if (cooldown > 0 || connecting) return;
    error = "";
    info = "";
    connecting = true;
    try {
      const base = getBaseUrl();
      const path =
        purpose === "reset" ? "/api/auth/password/reset/start" : "/api/auth/register/resend";
      const resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 429 && typeof data.retryAfterMs === "number") {
          startCooldown(Math.ceil(data.retryAfterMs / 1000));
        }
        throw new Error(data.error || "Couldn't resend the code");
      }
      devCodeHint = typeof data.devCode === "string" ? data.devCode : devCodeHint;
      info = "Code resent — check your inbox.";
      otpCode = "";
      startCooldown(30);
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't resend the code";
    } finally {
      connecting = false;
    }
  }

  // Forgot password — step 1: request a reset code for an existing account.
  // The server always reports success (no enumeration); we move to the reset
  // step regardless so the email is never confirmed/denied.
  async function requestPasswordReset() {
    error = "";
    info = "";
    if (!email) {
      error = "Email required";
      return;
    }
    connecting = true;
    try {
      const resp = await fetch(`${getBaseUrl()}/api/auth/password/reset/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok && resp.status !== 429) throw new Error(data.error || "Request failed");
      devCodeHint = typeof data.devCode === "string" ? data.devCode : "";
      otpCode = "";
      newPassword = "";
      confirmNewPassword = "";
      step = "reset";
      startCooldown(30);
    } catch (e) {
      error = e instanceof Error ? e.message : "Request failed";
    } finally {
      connecting = false;
    }
  }

  // Forgot password — step 2: verify the code + set the new password, then sign
  // in with the returned token.
  async function submitPasswordReset() {
    error = "";
    if (!/^\d{6}$/.test(otpCode)) {
      error = "Enter the 6-digit code";
      return;
    }
    if (newPassword.length < 6) {
      error = "Password must be at least 6 characters";
      return;
    }
    if (newPassword !== confirmNewPassword) {
      error = "Passwords don't match";
      return;
    }
    connecting = true;
    try {
      const resp = await fetch(`${getBaseUrl()}/api/auth/password/reset/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otpCode, newPassword }),
      });
      const data = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      if (!resp.ok) throw new Error(data.error || "Reset failed");
      await connectToServer(getWsUrl(), data.token);
      goAfterLogin();
    } catch (e) {
      error = e instanceof Error ? e.message : "Reset failed";
    } finally {
      connecting = false;
    }
  }

  // Check-list highlights for the hosting cards (one-liner + checks + CTA).
  const cloudChecks = [
    "Nothing to deploy",
    "Ready in minutes",
    "We manage updates and uptime",
  ];
  const selfhostChecks = [
    "Your server, your data",
    "Nothing leaves your network",
    "No telemetry, full control",
  ];
</script>

{#if viewportState.isMobile}
<!-- ── Mobile (<sm): full-screen native onboarding (P1 iOS redesign). ────────
     Full-bleed surface (no card, no glow), brand mark in the top third,
     email-first progressive disclosure. The desktop branch below is the
     pre-redesign page, untouched. All handlers/validation are shared. -->
<!-- Onboarding/auth is pinned to the light theme to match the design system's
     auth mocks, regardless of the app's (dark) default. data-theme scopes the
     light token block to this subtree via CSS custom-property inheritance — no
     JS, no fighting preferences.applyTheme(). -->
<div data-theme="light" class="relative z-10 flex h-full flex-col overflow-y-auto bg-surface">
  <div
    class="mx-auto flex min-h-full w-full max-w-sm flex-col px-6 pb-8"
    style="padding-top: calc(var(--sat, 0px) + 12px);"
  >
    {#if step === "mode" || step === "auth"}
      <div class="pt-[9vh] pb-8 text-center">
        <CyborgIcon size={56} class="mx-auto text-accent" />
        <h1 class="mt-5 text-[34px] leading-tight font-bold text-content">Welcome to Cyborg7</h1>
        <p class="mt-2 text-[15px] text-content-dim">Sign in or create an account to get started.</p>
      </div>

      <!-- iOS segmented-style control (same authMode handlers as desktop tabs) -->
      <div class="flex rounded-[10px] bg-raised p-0.5">
        <button
          type="button"
          onclick={() => setAuthModeMobile("login")}
          class="pressable flex-1 rounded-lg py-2 text-center text-[15px] font-medium transition-colors {authMode ===
          'login'
            ? 'bg-surface text-content shadow-sm'
            : 'text-content-dim'}">Log in</button
        >
        <button
          type="button"
          onclick={() => setAuthModeMobile("register")}
          class="pressable flex-1 rounded-lg py-2 text-center text-[15px] font-medium transition-colors {authMode ===
          'register'
            ? 'bg-surface text-content shadow-sm'
            : 'text-content-dim'}">Create account</button
        >
      </div>

      <form onsubmit={(e) => { e.preventDefault(); mobileContinue(); }} class="mt-5 space-y-3.5">
        {#if mode === "selfhost"}
          <div transition:slide={{ duration: 250 }}>
            <label for="server-url" class={mobileLabelCls}>Server URL</label>
            <input
              id="server-url"
              type="text"
              bind:value={serverUrl}
              placeholder="http://myserver.com:9100"
              autocapitalize="off"
              spellcheck="false"
              class={mobileInputCls}
            />
          </div>
        {/if}

        <div>
          <label for="email" class={mobileLabelCls}>Email</label>
          <input
            id="email"
            type="email"
            bind:value={email}
            placeholder="you@example.com"
            autocomplete="email"
            autocapitalize="off"
            spellcheck="false"
            class={mobileInputCls}
          />
        </div>

        {#if detailsRevealed}
          <div transition:slide={{ duration: 250 }} class="space-y-3.5">
            {#if authMode === "register"}
              <div>
                <label for="name" class={mobileLabelCls}>Name</label>
                <input
                  id="name"
                  type="text"
                  bind:value={name}
                  placeholder="Your display name"
                  autocomplete="name"
                  class={mobileInputCls}
                />
              </div>
            {/if}

            <div>
              <div class="mb-1.5 flex items-center justify-between">
                <label for="password" class="block text-[13px] font-medium text-content-dim">Password</label>
                {#if authMode === "login"}
                  <button
                    type="button"
                    onclick={() => { step = "forgot"; error = ""; info = ""; }}
                    class="text-[13px] text-content-muted"
                  >
                    Forgot password?
                  </button>
                {/if}
              </div>
              <input
                id="password"
                type="password"
                bind:value={password}
                placeholder={authMode === "register" ? "At least 6 characters" : ""}
                autocomplete={authMode === "register" ? "new-password" : "current-password"}
                class={mobileInputCls}
              />
            </div>

            {#if authMode === "register"}
              <div>
                <label for="confirm-password" class={mobileLabelCls}>Confirm password</label>
                <input
                  id="confirm-password"
                  type="password"
                  bind:value={confirmPassword}
                  autocomplete="new-password"
                  class={mobileInputCls}
                />
              </div>
            {/if}
          </div>
        {/if}

        {#if error}
          <p class="text-sm text-error">{error}</p>
        {/if}

        <button type="submit" disabled={connecting} class={mobileCtaCls}>
          {#if connecting}
            Connecting...
          {:else if !detailsRevealed}
            Continue
          {:else if authMode === "register"}
            Create account
          {:else}
            Log in
          {/if}
        </button>
      </form>

      <!-- Cloud/self-host choice demoted on mobile (desktop keeps the cards) -->
      <button
        type="button"
        onclick={toggleSelfHost}
        class="mx-auto mt-5 px-2 py-2 text-[13px] text-content-muted"
      >
        {mode === "selfhost" ? "Use Cyborg Cloud instead" : "Advanced: self-hosted server"}
      </button>

      <!-- App Store reviewers expect Privacy + Terms reachable BEFORE account
           creation. Plain external links — the root layout's external-link
           interceptor routes them to the OS browser on iOS. -->
      <p class="mt-auto pt-8 text-center text-[11px] leading-relaxed text-content-muted">
        By continuing, you agree to our
        <a href="https://www.cyborg7.com/terms" class="text-content-dim underline">Terms of Service</a>
        and
        <a href="https://www.cyborg7.com/privacy" class="text-content-dim underline">Privacy Policy</a>.
      </p>
    {:else if step === "otp"}
      <button onclick={goBack} class={mobileBackBtnCls} aria-label="Back">
        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <h1 class="mt-4 text-[28px] leading-tight font-bold text-content">Verify your email</h1>
      <p class="mt-2 text-[15px] text-content-dim">
        We sent a 6-digit code to <span class="font-medium text-content">{email}</span>. Enter it
        below to finish creating your account.
      </p>

      {#if devCodeHint}
        <p class="mt-5 rounded-[12px] bg-surface-alt px-4 py-3 text-[13px] text-content-muted">
          Dev mode (no email provider): your code is
          <span class="font-mono font-semibold text-content">{devCodeHint}</span>
        </p>
      {/if}
      {#if info}
        <p class="mt-5 rounded-[12px] bg-online/10 px-4 py-3 text-[13px] text-online">{info}</p>
      {/if}

      <form onsubmit={(e) => { e.preventDefault(); verifyOtp(); }} class="mt-6 space-y-5">
        <OtpInput bind:value={otpCode} />

        {#if error}
          <p class="text-sm text-error">{error}</p>
        {/if}

        <button type="submit" disabled={connecting} class={mobileCtaCls}>
          {connecting ? "Verifying..." : "Verify & continue"}
        </button>

        <button
          type="button"
          onclick={() => resendCode("signup")}
          disabled={connecting || cooldown > 0}
          class="w-full py-2 text-center text-[13px] text-content-muted disabled:opacity-40"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : "Didn't get it? Resend code"}
        </button>
      </form>
    {:else if step === "forgot"}
      <button onclick={goBack} class={mobileBackBtnCls} aria-label="Back">
        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <h1 class="mt-4 text-[28px] leading-tight font-bold text-content">Reset your password</h1>
      <p class="mt-2 text-[15px] text-content-dim">
        Enter your account email and we'll send a 6-digit code to reset your password.
      </p>

      <form onsubmit={(e) => { e.preventDefault(); requestPasswordReset(); }} class="mt-6 space-y-3.5">
        <div>
          <label for="forgot-email" class={mobileLabelCls}>Email</label>
          <input
            id="forgot-email"
            type="email"
            bind:value={email}
            placeholder="you@example.com"
            autocomplete="email"
            autocapitalize="off"
            spellcheck="false"
            class={mobileInputCls}
          />
        </div>

        {#if error}
          <p class="text-sm text-error">{error}</p>
        {/if}

        <button type="submit" disabled={connecting} class={mobileCtaCls}>
          {connecting ? "Sending..." : "Send reset code"}
        </button>
      </form>
    {:else}
      <!-- step === "reset" -->
      <button onclick={goBack} class={mobileBackBtnCls} aria-label="Back">
        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <h1 class="mt-4 text-[28px] leading-tight font-bold text-content">Set a new password</h1>
      <p class="mt-2 text-[15px] text-content-dim">
        Enter the code sent to <span class="font-medium text-content">{email}</span> and choose a
        new password.
      </p>

      {#if devCodeHint}
        <p class="mt-5 rounded-[12px] bg-surface-alt px-4 py-3 text-[13px] text-content-muted">
          Dev mode (no email provider): your code is
          <span class="font-mono font-semibold text-content">{devCodeHint}</span>
        </p>
      {/if}

      <form onsubmit={(e) => { e.preventDefault(); submitPasswordReset(); }} class="mt-6 space-y-3.5">
        <div>
          <span class={mobileLabelCls}>Reset code</span>
          <OtpInput bind:value={otpCode} />
        </div>

        <div>
          <label for="new-password" class={mobileLabelCls}>New password</label>
          <input
            id="new-password"
            type="password"
            bind:value={newPassword}
            placeholder="At least 6 characters"
            autocomplete="new-password"
            class={mobileInputCls}
          />
        </div>

        <div>
          <label for="confirm-new-password" class={mobileLabelCls}>Confirm new password</label>
          <input
            id="confirm-new-password"
            type="password"
            bind:value={confirmNewPassword}
            autocomplete="new-password"
            class={mobileInputCls}
          />
        </div>

        {#if error}
          <p class="text-sm text-error">{error}</p>
        {/if}

        <button type="submit" disabled={connecting} class={mobileCtaCls}>
          {connecting ? "Resetting..." : "Reset password & sign in"}
        </button>

        <button
          type="button"
          onclick={() => resendCode("reset")}
          disabled={connecting || cooldown > 0}
          class="w-full py-2 text-center text-[13px] text-content-muted disabled:opacity-40"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : "Didn't get it? Resend code"}
        </button>
      </form>
    {/if}
  </div>
</div>
{:else}
<div data-theme="light" class="auth-shell relative isolate flex h-full items-center justify-center overflow-hidden bg-surface p-4">
  <!-- Faint tech grid behind the card (figma onboarding redesign). Masked to a
       soft ellipse so it fades out toward the edges. Purely decorative. The
       figma auth surface is a clean light field + grid — no accent glow. -->
  <div class="auth-grid" aria-hidden="true"></div>

  <div class="relative z-10 flex w-full items-center justify-center">
  {#if step === "mode"}
    <div class="w-full max-w-2xl space-y-7">
      <div
        class="text-center"
        in:fly={{ y: reduced ? 0 : 10, duration: reduced ? 0 : 360, easing: cubicOut }}
      >
        <h1 class="text-xl font-bold text-content">Where does Cyborg run?</h1>
        <p class="mt-1 text-sm text-content-dim">No wrong answer here — pick what fits, and switch anytime.</p>
      </div>

      <div class="grid gap-3.5 sm:grid-cols-2">
        <!-- Cloud (recommended) -->
        <button
          onclick={() => chooseMode("cloud")}
          in:fly={{ y: reduced ? 0 : 16, duration: reduced ? 0 : 420, delay: reduced ? 0 : 90, easing: cubicOut }}
          class="hosting-card is-recommended group relative flex flex-col gap-3.5 rounded-2xl border border-edge bg-[var(--card)] p-5 text-left {chosen ===
          'cloud'
            ? 'is-chosen'
            : ''} {chosen && chosen !== 'cloud' ? 'is-dimmed' : ''}"
        >
          <span
            class="recommended-badge absolute right-3 top-3 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground shadow-sm"
            in:scale={{ start: 0.6, duration: reduced ? 0 : 420, delay: reduced ? 0 : 340, easing: cubicOut }}
            >Recommended</span
          >
          <span class="flex items-center gap-2.5">
            <span
              class="icon-tile flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-foreground shadow-sm"
            >
              <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
              </svg>
            </span>
            <span class="text-[15px] font-bold text-content">Cyborg Cloud</span>
          </span>
          <span class="block text-sm leading-relaxed text-content-dim">
            We host the workspace. You just connect your machines and go.
          </span>
          <span class="block space-y-2 border-t border-edge-dim pt-3.5">
            {#each cloudChecks as check (check)}
              <span class="flex items-start gap-2 text-[13px] text-content">
                <svg class="mt-0.5 h-4 w-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7" /></svg>
                {check}
              </span>
            {/each}
          </span>
          <!-- Pressable affordance: the whole card is the button, so this is a
               presentational (non-interactive) span, not a nested <button>. -->
          <span
            class="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-foreground transition-colors group-hover:bg-accent-hover"
          >
            Get started
            <svg class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M9 5l7 7-7 7" /></svg>
          </span>
        </button>

        <!-- Self-hosted -->
        <button
          onclick={() => chooseMode("selfhost")}
          in:fly={{ y: reduced ? 0 : 16, duration: reduced ? 0 : 420, delay: reduced ? 0 : 170, easing: cubicOut }}
          class="hosting-card group relative flex flex-col gap-3.5 rounded-2xl border border-edge bg-[var(--card)] p-5 text-left shadow-sm hover:border-edge-light {chosen ===
          'selfhost'
            ? 'is-chosen'
            : ''} {chosen && chosen !== 'selfhost' ? 'is-dimmed' : ''}"
        >
          <span class="flex items-center gap-2.5">
            <span class="icon-tile flex h-9 w-9 items-center justify-center rounded-lg bg-content/5 text-content-dim">
              <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </span>
            <span class="text-[15px] font-bold text-content">Self-hosted</span>
          </span>
          <span class="block text-sm leading-relaxed text-content-dim">
            Host the workspace on your own server. Everything stays inside your network.
          </span>
          <span class="block space-y-2 border-t border-edge-dim pt-3.5">
            {#each selfhostChecks as check (check)}
              <span class="flex items-start gap-2 text-[13px] text-content">
                <svg class="mt-0.5 h-4 w-4 shrink-0 text-content-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7" /></svg>
                {check}
              </span>
            {/each}
          </span>
          <!-- Presentational affordance (whole card is the button). Ghost style
               keeps Self-hosted secondary to the recommended Cloud CTA. -->
          <span
            class="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-[13px] font-medium text-content transition-colors group-hover:border-edge-light group-hover:bg-surface-hover"
          >
            Set up yourself
            <svg class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M9 5l7 7-7 7" /></svg>
          </span>
        </button>
      </div>

      <!-- App Store reviewers expect Privacy + Terms reachable BEFORE
           account creation, not buried behind a sign-in. These are plain
           external links — the root layout's external-link interceptor routes
           them to the OS browser on iOS. -->
      <p
        class="text-center text-[11px] leading-relaxed text-content-muted"
        in:fade={{ duration: reduced ? 0 : 300, delay: reduced ? 0 : 420 }}
      >
        By continuing, you agree to our
        <a href="https://www.cyborg7.com/terms" class="text-content-dim underline">Terms of Service</a>
        and
        <a href="https://www.cyborg7.com/privacy" class="text-content-dim underline">Privacy Policy</a>.
      </p>
    </div>
  {:else if step === "auth"}
    <div
      class="w-full max-w-sm rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm"
      in:fly={{ y: reduced ? 0 : 10, duration: reduced ? 0 : 280, easing: cubicOut }}
    >

      <div class="space-y-5">
        <CyborgIcon size={28} class="mx-auto text-content" />
        <div class="flex items-center gap-2">
          <button
            onclick={goBack}
            class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            aria-label="Back"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 class="text-lg font-bold text-content">
            {mode === "cloud" ? "Cyborg Cloud" : "Self-hosted"}
          </h1>
        </div>

        <div class="flex rounded-full bg-raised p-1">
          <button
            onclick={() => {
              authMode = "login";
              error = "";
            }}
            class="flex-1 rounded-full py-2 text-center text-sm font-semibold transition-all {authMode ===
            'login'
              ? 'bg-card text-content shadow-sm ring-1 ring-edge/40'
              : 'font-medium text-content-dim hover:text-content'}">Log in</button
          >
          <button
            onclick={() => {
              authMode = "register";
              error = "";
            }}
            class="flex-1 rounded-full py-2 text-center text-sm font-semibold transition-all {authMode ===
            'register'
              ? 'bg-card text-content shadow-sm ring-1 ring-edge/40'
              : 'font-medium text-content-dim hover:text-content'}">Create account</button
          >
        </div>

        <form onsubmit={(e) => { e.preventDefault(); handleAuth(); }} class="space-y-3.5">
          {#if mode === "selfhost"}
            <div>
              <label for="server-url" class="mb-1.5 block text-[13px] font-medium text-content"
                >Server URL</label
              >
              <input
                id="server-url"
                type="text"
                bind:value={serverUrl}
                placeholder="http://myserver.com:9100"
                class={inputCls}
              />
              {#if isDevLocalhost}
                <p class="mt-1.5 text-[12px] text-content-muted">
                  Dev mode: defaulting to your local relay ({LOCAL_RELAY_URL}).
                </p>
              {/if}
            </div>
          {/if}

          {#if authMode === "register"}
            <div>
              <label for="name" class="mb-1.5 block text-[13px] font-medium text-content">Name</label>
              <input id="name" name="name" type="text" autocomplete="name" bind:value={name} placeholder="Your display name" class={inputCls} />
            </div>
          {/if}

          <div>
            <label for="email" class="mb-1.5 block text-[13px] font-medium text-content">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="username webauthn"
              bind:value={email}
              placeholder="you@example.com"
              class={inputCls}
            />
          </div>

          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label for="password" class="block text-[13px] font-medium text-content">Password</label>
              {#if authMode === "login"}
                <button
                  type="button"
                  onclick={() => { step = "forgot"; error = ""; info = ""; }}
                  class="text-[12px] text-content-muted transition-colors hover:text-content"
                >
                  Forgot password?
                </button>
              {/if}
            </div>
            <div class="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                bind:value={password}
                autocomplete={authMode === "register" ? "new-password" : "current-password"}
                class="{inputCls} pr-10"
              />
              <button
                type="button"
                onclick={() => (showPassword = !showPassword)}
                class="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-content-muted transition-colors hover:text-content"
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabindex="-1"
              >
                {#if showPassword}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
              </button>
            </div>
            {#if authMode === "register"}
              <p class="mt-1.5 text-[12px] text-content-muted">Use at least 6 characters.</p>
            {/if}
          </div>

          {#if authMode === "register"}
            <div>
              <label for="confirm-password" class="mb-1.5 block text-[13px] font-medium text-content"
                >Confirm password</label
              >
              <div class="relative">
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  bind:value={confirmPassword}
                  autocomplete="new-password"
                  class="{inputCls} pr-10"
                />
                <button
                  type="button"
                  onclick={() => (showConfirmPassword = !showConfirmPassword)}
                  class="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-content-muted transition-colors hover:text-content"
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                  tabindex="-1"
                >
                  {#if showConfirmPassword}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
                </button>
              </div>
            </div>
          {/if}

          {#if error}
            <p class="text-xs text-error">{error}</p>
          {/if}

          <button
            type="submit"
            disabled={connecting}
            class="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {#if connecting}
              Connecting...
            {:else if authMode === "register"}
              Create account
            {:else}
              Log in
            {/if}
          </button>

          {#if hasPasskeys && authMode === "login"}
            <div class="flex items-center gap-3 pt-1">
              <span class="h-px flex-1 bg-edge"></span>
              <span class="text-[11px] text-content-muted">or</span>
              <span class="h-px flex-1 bg-edge"></span>
            </div>
            <button
              type="button"
              onclick={loginWithPasskey}
              disabled={connecting}
              class="flex w-full items-center justify-center gap-2 rounded-lg border border-edge py-2 text-sm font-medium text-content transition-colors hover:border-edge-light hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Fingerprint class="h-4 w-4" />
              Continue with passkey
            </button>
          {/if}
        </form>
      </div>
    </div>
  {:else if step === "otp"}
    <div
      class="w-full max-w-sm rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm"
      in:fly={{ y: reduced ? 0 : 10, duration: reduced ? 0 : 280, easing: cubicOut }}
    >
      <div class="space-y-5">
        <div class="flex items-center gap-2">
          <button
            onclick={goBack}
            class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            aria-label="Back"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 class="text-lg font-bold text-content">Verify your email</h1>
        </div>

        <p class="text-sm text-content-dim">
          We sent a 6-digit code to <span class="font-medium text-content">{email}</span>. Enter it
          below to finish creating your account.
        </p>

        {#if devCodeHint}
          <p class="rounded-md bg-surface-hover px-3 py-2 text-xs text-content-muted">
            Dev mode (no email provider): your code is
            <span class="font-mono font-semibold text-content">{devCodeHint}</span>
          </p>
        {/if}
        {#if info}
          <p class="rounded-md bg-success/10 px-3 py-2 text-xs text-success">{info}</p>
        {/if}

        <form onsubmit={(e) => { e.preventDefault(); verifyOtp(); }} class="space-y-3.5">
          <div>
            <label for="otp-code" class="mb-1.5 block text-[13px] font-medium text-content">
              Verification code
            </label>
            <input
              id="otp-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              bind:value={otpCode}
              placeholder="123456"
              class="{inputCls} text-center text-lg tracking-[0.4em]"
            />
          </div>

          {#if error}
            <p class="text-xs text-error">{error}</p>
          {/if}

          <button
            type="submit"
            disabled={connecting}
            class="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? "Verifying..." : "Verify & continue"}
          </button>

          <button
            type="button"
            onclick={() => resendCode("signup")}
            disabled={connecting || cooldown > 0}
            class="w-full text-center text-xs text-content-muted transition-colors hover:text-content disabled:opacity-40"
          >
            {cooldown > 0 ? `Resend code in ${cooldown}s` : "Didn't get it? Resend code"}
          </button>
        </form>
      </div>
    </div>
  {:else if step === "forgot"}
    <div
      class="w-full max-w-sm rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm"
      in:fly={{ y: reduced ? 0 : 10, duration: reduced ? 0 : 280, easing: cubicOut }}
    >
      <div class="space-y-5">
        <div class="flex items-center gap-2">
          <button
            onclick={goBack}
            class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            aria-label="Back"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 class="text-lg font-bold text-content">Reset your password</h1>
        </div>
        <p class="text-sm text-content-dim">
          Enter your account email and we'll send a 6-digit code to reset your password.
        </p>
        <form onsubmit={(e) => { e.preventDefault(); requestPasswordReset(); }} class="space-y-3.5">
          <div>
            <label for="forgot-email" class="mb-1.5 block text-[13px] font-medium text-content">Email</label>
            <input id="forgot-email" name="email" type="email" autocomplete="username" bind:value={email} placeholder="you@example.com" class={inputCls} />
          </div>
          {#if error}<p class="text-xs text-error">{error}</p>{/if}
          <button
            type="submit"
            disabled={connecting}
            class="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? "Sending..." : "Send reset code"}
          </button>
        </form>
      </div>
    </div>
  {:else}
    <!-- step === "reset" -->
    <div
      class="w-full max-w-sm rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm"
      in:fly={{ y: reduced ? 0 : 10, duration: reduced ? 0 : 280, easing: cubicOut }}
    >
      <div class="space-y-5">
        <div class="flex items-center gap-2">
          <button
            onclick={goBack}
            class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            aria-label="Back"
          >
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h1 class="text-lg font-bold text-content">Set a new password</h1>
        </div>
        <p class="text-sm text-content-dim">
          Enter the code sent to <span class="font-medium text-content">{email}</span> and choose a
          new password.
        </p>
        {#if devCodeHint}
          <p class="rounded-md bg-surface-hover px-3 py-2 text-xs text-content-muted">
            Dev mode (no email provider): your code is
            <span class="font-mono font-semibold text-content">{devCodeHint}</span>
          </p>
        {/if}
        <form onsubmit={(e) => { e.preventDefault(); submitPasswordReset(); }} class="space-y-3.5">
          <div>
            <label for="reset-code" class="mb-1.5 block text-[13px] font-medium text-content">Reset code</label>
            <input id="reset-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" bind:value={otpCode} placeholder="123456" class="{inputCls} text-center text-lg tracking-[0.4em]" />
          </div>
          <div>
            <label for="new-password" class="mb-1.5 block text-[13px] font-medium text-content">New password</label>
            <input id="new-password" type="password" bind:value={newPassword} placeholder="At least 6 characters" class={inputCls} />
          </div>
          <div>
            <label for="confirm-new-password" class="mb-1.5 block text-[13px] font-medium text-content">Confirm new password</label>
            <input id="confirm-new-password" type="password" bind:value={confirmNewPassword} class={inputCls} />
          </div>
          {#if error}<p class="text-xs text-error">{error}</p>{/if}
          <button
            type="submit"
            disabled={connecting}
            class="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? "Resetting..." : "Reset password & sign in"}
          </button>
          <button
            type="button"
            onclick={() => resendCode("reset")}
            disabled={connecting || cooldown > 0}
            class="w-full text-center text-xs text-content-muted transition-colors hover:text-content disabled:opacity-40"
          >
            {cooldown > 0 ? `Resend code in ${cooldown}s` : "Didn't get it? Resend code"}
          </button>
        </form>
      </div>
    </div>
  {/if}
  </div>
</div>
{/if}

<style>
  /* Faint tech grid behind the auth card (figma onboarding redesign). Lines
     derive from the text color at low alpha so they read in any theme; a radial
     mask fades the grid out toward the edges so it only whispers behind the
     card. The designer note asks for an animated reveal later — kept static
     here, but the mask/opacity are the obvious hooks to animate. */
  .auth-grid {
    position: absolute;
    pointer-events: none;
    z-index: 0;
    inset: -5%;
    background-image:
      linear-gradient(to right, color-mix(in oklch, var(--color-content) 7%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom, color-mix(in oklch, var(--color-content) 7%, transparent) 1px, transparent 1px);
    background-size: 54px 54px;
    -webkit-mask-image: radial-gradient(ellipse 55% 50% at 50% 50%, #000 0%, transparent 72%);
    mask-image: radial-gradient(ellipse 55% 50% at 50% 50%, #000 0%, transparent 72%);
    /* Slow, barely-perceptible drift so the field feels alive without pulling
       focus from the cards. One grid cell per cycle = seamless loop. */
    animation: grid-drift 36s linear infinite;
  }

  @keyframes grid-drift {
    from {
      background-position: 0 0, 0 0;
    }
    to {
      background-position: 54px 54px, 54px 54px;
    }
  }

  /* Hosting cards: lift on hover, accent ring + scale when chosen, dim the other
     card so the selection reads instantly before the view advances. */
  .hosting-card {
    transition:
      transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 180ms ease,
      border-color 180ms ease,
      opacity 240ms ease,
      filter 240ms ease;
    will-change: transform;
  }
  .hosting-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 18px 40px -16px color-mix(in oklch, var(--color-content) 26%, transparent);
  }
  .hosting-card:active {
    transform: translateY(-1px) scale(0.995);
  }
  /* Recommended (Cloud) card wins at rest: faint accent tint, accent-tinted
     border + ambient accent shadow so the eye lands here first. Two-class
     selector outweighs the bg utility so the tint applies cleanly. */
  .hosting-card.is-recommended {
    border-color: color-mix(in oklch, var(--color-accent) 40%, transparent);
    background-color: color-mix(in oklch, var(--color-accent) 4%, var(--card));
    box-shadow: 0 14px 36px -18px color-mix(in oklch, var(--color-accent) 30%, transparent);
  }
  .hosting-card.is-recommended:hover {
    border-color: color-mix(in oklch, var(--color-accent) 60%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in oklch, var(--color-accent) 32%, transparent),
      0 20px 46px -16px color-mix(in oklch, var(--color-accent) 38%, transparent);
  }
  .hosting-card.is-chosen {
    transform: translateY(-3px) scale(1.015);
    border-color: var(--color-btn-primary-bg);
    box-shadow:
      0 0 0 2px color-mix(in oklch, var(--color-btn-primary-bg) 55%, transparent),
      0 18px 44px -16px color-mix(in oklch, var(--color-btn-primary-bg) 32%, transparent);
  }
  .hosting-card.is-dimmed {
    opacity: 0.45;
    transform: scale(0.985);
    filter: saturate(0.7);
  }

  /* Icon tile floats a hair on card hover. */
  .icon-tile {
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .hosting-card:hover .icon-tile {
    transform: translateY(-2px);
  }

  /* Gentle one-time attention on the recommended badge, just after it pops in. */
  .recommended-badge {
    animation: badge-pulse 2.4s ease-in-out 0.9s 2;
  }
  @keyframes badge-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in oklch, var(--color-accent) 24%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .auth-grid,
    .recommended-badge {
      animation: none;
    }
    .hosting-card,
    .hosting-card:hover,
    .hosting-card:active,
    .hosting-card.is-chosen,
    .hosting-card.is-dimmed,
    .icon-tile,
    .hosting-card:hover .icon-tile {
      transition: none;
      transform: none;
    }
  }
</style>
