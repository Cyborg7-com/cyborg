<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { isDesktopApp } from "$lib/utils.js";
  import { MAC_DMG, WINDOWS_EXE } from "$lib/desktop-downloads.js";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import AppleLogo from "$lib/components/brand/AppleLogo.svelte";
  import WindowsLogo from "$lib/components/brand/WindowsLogo.svelte";

  type OS = "mac" | "windows" | "mobile" | "other";

  // Where to send the user after this gate. The invite/onboarding flows pass a
  // same-origin path (?next=/workspace/<id>). Restricted to paths starting with
  // "/" so it can't be used as an open redirect; defaults to /workspace.
  const rawNext = page.url.searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") ? rawNext : "/workspace";

  function detectOS(): OS {
    if (typeof navigator === "undefined") return "other";
    const ua = navigator.userAgent;
    // Phones/tablets first — a desktop installer is useless on these.
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "mobile";
    if (/Mac/i.test(ua)) return "mac";
    if (/Win/i.test(ua)) return "windows";
    return "other";
  }

  let os = $state<OS>("other");
  // Hide the whole step until the desktop check has run so desktop users never
  // see a flash of the download gate before the instant redirect.
  let ready = $state(false);

  $effect(() => {
    // Desktop users are already in the app — skip the gate entirely.
    if (isDesktopApp()) {
      goto(next);
      return;
    }
    os = detectOS();
    ready = true;
  });

  // The platform we lead with, and the one we offer as the alternative. Each
  // carries a `platform` tag so the button can render the right brand logo.
  const macBtn = { label: "Download for macOS", href: MAC_DMG, platform: "mac" as const };
  const winBtn = { label: "Download for Windows", href: WINDOWS_EXE, platform: "windows" as const };
  const primary = $derived(os === "windows" ? winBtn : macBtn);
  const secondary = $derived(os === "windows" ? macBtn : winBtn);

  function continueInBrowser(): void {
    goto(next);
  }
</script>

<!-- One download button shape for all four uses (mobile mac/win, desktop
     primary/secondary): only href, logo, label and fill differ. -->
{#snippet dlButton(href: string, platform: "mac" | "windows", label: string, filled: boolean)}
  <a
    {href}
    target="_blank"
    rel="noopener noreferrer"
    class="flex w-full items-center justify-center gap-2.5 rounded-lg py-2.5 text-sm transition-colors {filled
      ? 'bg-btn-primary-bg font-semibold text-btn-primary-text hover:bg-btn-primary-hover'
      : 'border border-edge bg-[var(--card)] font-medium text-content hover:border-edge-light hover:bg-surface-hover'}"
  >
    {#if platform === "mac"}
      <AppleLogo class="size-[18px]" />
    {:else}
      <WindowsLogo class="size-4" />
    {/if}
    {label}
  </a>
{/snippet}

<div class="auth-shell relative isolate flex h-full items-center justify-center overflow-hidden bg-surface p-4">
  <div class="auth-veil-top" aria-hidden="true"></div>
  <div class="auth-glow" aria-hidden="true"></div>
  <div class="auth-glow-hot" aria-hidden="true"></div>

  {#if ready}
    <div class="relative z-10 flex w-full items-center justify-center">
      <div class="w-full max-w-md rounded-[var(--radius)] border border-edge bg-[var(--card)]/90 p-8 shadow-xl shadow-black/20 backdrop-blur-sm">
        <div class="space-y-6 text-center">
          <CyborgIcon size={28} class="mx-auto text-accent" />

          <div class="space-y-2">
            <h1 class="text-xl font-bold text-content">Get your first machine online</h1>
            {#if os === "mobile"}
              <p class="text-sm text-content-dim">
                Your agents run on a real computer. Install Cyborg on a Mac or Windows
                machine — it becomes your first one. You can keep looking around in this
                browser for now.
              </p>
            {:else}
              <p class="text-sm text-content-dim">
                Your agents run on a real computer — the Cyborg desktop app
                <strong class="font-semibold text-content">is</strong> that machine. Install it
                and you're ready to put your agents to work. Takes less than a minute.
              </p>
            {/if}
          </div>

          {#if os === "mobile"}
            <div class="space-y-2.5 rounded-xl border border-edge bg-surface-alt/40 p-4 text-left">
              <p class="text-[13px] font-medium text-content">Available for desktop</p>
              {@render dlButton(MAC_DMG, "mac", "Download for macOS", false)}
              {@render dlButton(WINDOWS_EXE, "windows", "Download for Windows", false)}
            </div>
          {:else}
            <div class="space-y-3">
              {@render dlButton(primary.href, primary.platform, primary.label, true)}
              {@render dlButton(secondary.href, secondary.platform, secondary.label, false)}
            </div>
          {/if}

          <div class="border-t border-edge-dim pt-5">
            <button
              type="button"
              onclick={continueInBrowser}
              class="text-[13px] text-content-muted transition-colors hover:text-content"
            >
              I'll set up my machine later →
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Decorative accent glow — ported from the auth screens (login/+page.svelte,
     invite/[token]/+page.svelte) so this welcome step matches the sign-in look.
     Layers are pointer-events:none and aria-hidden. */
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
