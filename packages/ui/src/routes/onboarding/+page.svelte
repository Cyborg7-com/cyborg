<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import {
    client,
    workspaceState,
    authState,
    selectWorkspace,
    createWorkspace,
    connectToServer,
    getSavedSession,
    clearSavedSession,
  } from "$lib/state/app.svelte.js";
  import { isTauriIOS } from "$lib/mobile/push";
  import { getInitials, isDesktopApp } from "$lib/utils.js";

  // iOS keyboard fix (v1 login/+page.svelte parity). The native push layer pins
  // WKWebView's outer scroll to zero, so iOS can't auto-scroll the focused
  // workspace-name input into view — the keyboard covers it. Manually center the
  // focused input on focus. iOS-gated only; web/desktop/Android are untouched.
  onMount(() => {
    if (!isTauriIOS()) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") return;
      setTimeout(() => target.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  });

  // First-run onboarding for NEW accounts only (login routes registrations here;
  // returning users go straight to /workspace). Registration auto-creates a
  // workspace; this flow lets the user name their workspace, then drops them
  // into the app.

  type Phase = "workspace" | "done";

  // The hosting choice (cloud vs self-host) is made earlier, at /login. The
  // 7-day trial is server-anchored to workspace creation and surfaced in-app by
  // TrialBar, so there's no trial step here — the wizard just names the
  // workspace and enters. (See internal docs for the onboarding rationale.)
  let phase = $state<Phase>("workspace");

  // Start in the restoring state when unauthenticated so the form never flashes
  // before the redirect/restore resolves.
  let restoring = $state(!authState.authenticated);
  let restoreAttempted = false;
  let saving = $state(false);
  let error = $state("");

  let name = $state("");
  let logoFile: File | null = $state(null);
  let logoPreview = $state<string | null>(null);
  let logoUrl: string | null = null;
  let fileInput: HTMLInputElement | undefined = $state();

  // The user's OWN auto-created workspace — the one they're the owner of. NOT
  // list[0]: registering with pending invites also returns the invited
  // workspaces (in no guaranteed order), and renaming one of those would 403
  // for a member role or clobber someone else's workspace for an admin role.
  const workspace = $derived(workspaceState.list.find((w) => w.role === "owner") ?? null);

  $effect(() => {
    if (!authState.authenticated && !restoreAttempted) {
      restoreAttempted = true;
      void tryRestore();
    }
  });

  // Prefill the name from the workspace once (tracking flag, not `!name`, so
  // clearing the input to retype a name doesn't instantly snap it back).
  let prefilled = false;
  $effect(() => {
    if (workspace && !prefilled) {
      name = workspace.name;
      prefilled = true;
    }
  });

  async function tryRestore(): Promise<void> {
    const saved = getSavedSession();
    if (!saved) {
      goto("/login");
      return;
    }
    restoring = true;
    try {
      await connectToServer(saved.url, saved.token);
    } catch {
      clearSavedSession();
      goto("/login");
    } finally {
      restoring = false;
    }
  }

  function pickLogo(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      error = "Please select a valid image file.";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      error = "Image must be under 5MB.";
      return;
    }
    error = "";
    // Revoke the previous preview URL before replacing it (object URLs aren't
    // freed automatically).
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    logoFile = file;
    logoPreview = URL.createObjectURL(file);
  }

  function clearLogo(): void {
    logoFile = null;
    if (logoPreview) {
      URL.revokeObjectURL(logoPreview);
      logoPreview = null;
    }
    if (fileInput) fileInput.value = "";
  }

  // Free any outstanding preview URL when leaving the page.
  $effect(() => () => {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
  });

  async function handleContinue(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    saving = true;
    error = "";
    try {
      if (logoFile) {
        const { publicUrl } = await client.uploadAsset(logoFile, "workspace-avatars");
        logoUrl = publicUrl;
      }
      let ws = workspace;
      // Fallback: if registration didn't leave an owned workspace, create one.
      if (!ws) {
        ws = await createWorkspace(trimmed);
        if (logoUrl) {
          await client.updateWorkspace(ws.id, { avatarUrl: logoUrl });
          // Sync local state so the avatar shows without a reload.
          const local = workspaceState.list.find((w) => w.id === ws!.id);
          if (local) local.avatarUrl = logoUrl;
        }
      } else {
        await client.updateWorkspace(ws.id, {
          name: trimmed,
          ...(logoUrl ? { avatarUrl: logoUrl } : {}),
        });
        // Keep local state in sync so the picker/app reflect the new identity.
        ws.name = trimmed;
        if (logoUrl) ws.avatarUrl = logoUrl;
      }
      phase = "done";
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save your workspace";
    } finally {
      saving = false;
    }
  }

  async function enterApp(): Promise<void> {
    const ws = workspace;
    if (!ws) {
      goto("/workspace");
      return;
    }
    await selectWorkspace(ws);
    // Web users get the skippable "download the desktop app" gate first;
    // desktop users are already in the app, so go straight to the workspace.
    if (isDesktopApp()) {
      goto(`/workspace/${ws.id}`);
    } else {
      goto(`/welcome/download?next=${encodeURIComponent(`/workspace/${ws.id}`)}`);
    }
  }
</script>

<div class="flex h-full items-center justify-center bg-surface p-4">
  {#if restoring}
    <div class="flex items-center gap-3 text-sm text-content-muted">
      <div class="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent"></div>
      <span>Setting things up…</span>
    </div>
  {:else if phase === "workspace"}
    <div class="w-full max-w-md space-y-7">
      <div class="text-center">
        <p class="text-xs font-semibold uppercase tracking-wide text-content-muted">Almost there</p>
        <h1 class="mt-1 text-xl font-bold text-content">Tell us about your workspace</h1>
        <p class="mt-1 text-sm text-content-dim">Just the basics. You can change everything later.</p>
      </div>

      <div class="space-y-5 rounded-2xl border border-edge bg-[var(--card)] p-6">
        <div>
          <span class="mb-1.5 block text-[13px] font-medium text-content">Workspace logo</span>
          <div class="flex items-center gap-3">
            <button
              type="button"
              onclick={() => fileInput?.click()}
              class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-edge bg-surface-alt text-content-muted transition-colors hover:border-edge-light"
              aria-label="Upload workspace logo"
            >
              {#if logoPreview}
                <img src={logoPreview} alt="Workspace logo preview" class="h-full w-full object-cover" />
              {:else if name.trim()}
                <span class="text-lg font-bold text-content">{getInitials(name)}</span>
              {:else}
                <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14" stroke-linecap="round" />
                </svg>
              {/if}
            </button>
            <div class="space-y-1">
              <p class="text-xs text-content-muted">Optional. PNG, JPG or SVG.</p>
              {#if logoPreview}
                <button type="button" onclick={clearLogo} class="text-xs text-link hover:underline">Remove</button>
              {/if}
            </div>
            <input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={pickLogo} />
          </div>
        </div>

        <div>
          <label for="ws-name" class="mb-1.5 block text-[13px] font-medium text-content">Workspace name</label>
          <input
            id="ws-name"
            type="text"
            bind:value={name}
            placeholder="e.g. Hartmann & Reyes"
            class="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm text-content outline-none placeholder:text-content-muted focus:border-edge-light focus:ring-[3px] focus:ring-edge/30 transition-shadow"
          />
          <p class="mt-1 text-xs text-content-muted">Usually your company or team name.</p>
        </div>

        {#if error}
          <p class="text-xs text-error">{error}</p>
        {/if}

        <button
          type="button"
          onclick={handleContinue}
          disabled={saving || !name.trim()}
          class="w-full rounded-lg bg-btn-primary-bg py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  {:else}
    <div class="w-full max-w-md space-y-6 text-center">
      <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-btn-primary-bg/15 text-btn-primary-bg">
        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4">
          <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div>
        <h1 class="text-xl font-bold text-content">You're all set</h1>
        <p class="mt-1 text-sm text-content-dim">
          Your workspace is ready. Head to the <strong class="font-semibold text-content">Agents</strong> tab when
          you want to add your first agent.
        </p>
      </div>

      <div class="space-y-2 rounded-2xl border border-edge bg-[var(--card)] p-5 text-left">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="text-content-muted">Workspace</span>
          <span class="font-medium text-content">{name.trim() || workspace?.name}</span>
        </div>
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="text-content-muted">Agents</span>
          <span class="italic text-content-muted">none yet — add from the Agents tab</span>
        </div>
      </div>

      <button
        type="button"
        onclick={enterApp}
        class="w-full rounded-lg bg-btn-primary-bg py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
      >
        Enter {name.trim() || "workspace"}
      </button>
    </div>
  {/if}
</div>
