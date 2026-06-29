<script lang="ts">
  import { authState, updateProfileImage, updateProfileName, client } from "$lib/state/app.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import { passkeySupported, type PasskeyInfo } from "$lib/passkey";

  const user = $derived(authState.user);
  // Prefer the just-uploaded optimistic image, then the persisted PG avatar.
  const profileImage = $derived(authState.user?.imageUrl ?? authState.profileImage);
  const userName = $derived(user?.name ?? user?.email ?? "User");

  // Seed from the user, re-seeding when the user identity changes (e.g. after an
  // auth refresh) rather than capturing it once (state_referenced_locally, #178).
  // Guarded by id so a background refresh of the same user can't clobber an
  // in-progress edit.
  let displayName = $state("");
  let seededUserId: string | undefined;
  $effect(() => {
    if (user?.id !== seededUserId) {
      seededUserId = user?.id;
      displayName = user?.name ?? "";
    }
  });
  let saving = $state(false);
  let profileMsg = $state("");
  let fileEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (user?.name !== undefined && user?.name !== null) displayName = user.name;
  });

  function flash(msg: string, ms = 2000) {
    profileMsg = msg;
    setTimeout(() => { profileMsg = ""; }, ms);
  }

  async function handleSave() {
    if (saving) return;
    saving = true;
    profileMsg = "";
    try {
      // Persists via cyborg:set_profile_name (relay → users.name) and updates
      // the active session; the relay broadcasts members_updated so others see it.
      await updateProfileName(displayName.trim());
      flash("Profile updated");
    } catch {
      flash("Failed to update profile");
    } finally {
      saving = false;
    }
  }

  function uploadBlob(blob: Blob | null) {
    if (!blob) return;
    // Capture the current avatar so a failed upload can roll back the optimistic
    // update instead of leaving a stale/broken image.
    const prevImage = authState.user?.imageUrl ?? authState.profileImage ?? null;
    const upload = new File([blob], "avatar.jpg", { type: "image/jpeg" });
    void updateProfileImage(upload).catch(() => {
      authState.setProfileImage(prevImage);
      flash("Failed to update profile picture");
    });
  }

  function processImage(img: HTMLImageElement) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = Math.min(img.width, img.height);
    const sx = (img.width - size) / 2;
    const sy = (img.height - size) / 2;
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);

    // Optimistically show the local preview; the resized blob persists to S3 + PG.
    authState.setProfileImage(canvas.toDataURL("image/jpeg", 0.82));
    canvas.toBlob(uploadBlob, "image/jpeg", 0.82);
  }

  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const img = new Image();
      img.addEventListener("load", () => processImage(img));
      img.src = reader.result as string;
    });
    reader.readAsDataURL(file);
    input.value = "";
  }

  // ── Passkeys ────────────────────────────────────────────────────
  const canUsePasskeys = passkeySupported();
  let passkeys = $state<PasskeyInfo[]>([]);
  let passkeysLoading = $state(false);
  let passkeyBusy = $state(false);
  let passkeyMsg = $state("");

  async function loadPasskeys() {
    if (!canUsePasskeys) return;
    passkeysLoading = true;
    try {
      passkeys = await client.listPasskeys();
    } catch (e) {
      passkeyMsg = e instanceof Error ? e.message : "Couldn't load passkeys";
    } finally {
      passkeysLoading = false;
    }
  }

  // Load the user's passkeys once their identity is known.
  let loadedForUser: string | undefined;
  $effect(() => {
    if (canUsePasskeys && user?.id && user.id !== loadedForUser) {
      loadedForUser = user.id;
      void loadPasskeys();
    }
  });

  async function addPasskey() {
    if (passkeyBusy) return;
    passkeyBusy = true;
    passkeyMsg = "";
    try {
      await client.registerPasskey();
      passkeyMsg = "Passkey added";
      await loadPasskeys();
    } catch (e) {
      // User-cancelled prompts (NotAllowedError/AbortError) aren't failures.
      const name = e instanceof Error ? e.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        passkeyMsg = e instanceof Error ? e.message : "Couldn't add passkey";
      }
    } finally {
      passkeyBusy = false;
    }
  }

  async function removePasskey(id: string) {
    if (passkeyBusy) return;
    passkeyBusy = true;
    try {
      await client.deletePasskey(id);
      await loadPasskeys();
    } catch (e) {
      passkeyMsg = e instanceof Error ? e.message : "Couldn't remove passkey";
    } finally {
      passkeyBusy = false;
    }
  }

  function fmtPasskeyDate(s: string | null): string {
    if (!s) return "never";
    return new Date(s).toLocaleDateString();
  }
</script>

<input
  bind:this={fileEl}
  type="file"
  accept="image/png,image/jpeg,image/gif"
  class="hidden"
  onchange={handleFileChange}
/>

<div class="flex items-center gap-4">
  <Avatar name={userName} width={56} fontSize={22} borderRadius="50%" image={profileImage} />
  <div class="flex flex-col gap-2">
    <div>
      <p class="text-[14px] font-semibold text-content">Profile Picture</p>
      <p class="text-[12px] text-content-muted">We only support PNGs, JPEGs and GIFs under 10MB</p>
    </div>
    <button
      type="button"
      onclick={() => fileEl?.click()}
      class="inline-flex w-fit items-center gap-2 rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-alt transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
      Upload image
    </button>
  </div>
</div>

<div class="space-y-1.5">
  <label for="profile-display-name" class="block text-xs font-medium text-content-muted uppercase tracking-wider">
    Display Name
  </label>
  <input
    id="profile-display-name"
    bind:value={displayName}
    placeholder="Your name"
    class="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted outline-none focus:border-accent"
  />
</div>

<div class="space-y-1.5">
  <label for="profile-email" class="block text-xs font-medium text-content-muted uppercase tracking-wider">
    Email
  </label>
  <input
    id="profile-email"
    value={user?.email ?? ""}
    readonly
    class="w-full cursor-not-allowed rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content opacity-60 outline-none"
  />
  <p class="text-[11px] text-content-muted">Email cannot be changed here</p>
</div>

{#if canUsePasskeys}
  <div class="space-y-3 border-t border-edge pt-5">
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="text-[14px] font-semibold text-content">Passkeys</p>
        <p class="text-[12px] text-content-muted">
          Sign in with Touch ID, Face ID, or a security key — no password to type.
        </p>
      </div>
      <button
        type="button"
        onclick={addPasskey}
        disabled={passkeyBusy}
        class="inline-flex w-fit shrink-0 items-center gap-2 rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-alt transition-colors disabled:opacity-40"
      >
        {passkeyBusy ? "Working…" : "Add passkey"}
      </button>
    </div>

    {#if passkeysLoading}
      <p class="text-[12px] text-content-muted">Loading…</p>
    {:else if passkeys.length === 0}
      <p class="text-[12px] text-content-muted">
        No passkeys yet. Add one for faster, passwordless sign-in.
      </p>
    {:else}
      <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
        {#each passkeys as pk (pk.id)}
          <li class="flex items-center justify-between gap-3 px-3 py-2">
            <div class="min-w-0">
              <p class="truncate text-[13px] text-content">
                {pk.nickname ?? (pk.deviceType === "multiDevice" ? "Synced passkey" : "Passkey")}
              </p>
              <p class="text-[11px] text-content-muted">
                Added {fmtPasskeyDate(pk.createdAt)} · Last used {fmtPasskeyDate(pk.lastUsedAt)}
              </p>
            </div>
            <button
              type="button"
              onclick={() => removePasskey(pk.id)}
              disabled={passkeyBusy}
              class="shrink-0 text-[12px] text-error hover:underline disabled:opacity-40"
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if passkeyMsg}
      <span
        class={/couldn|fail/i.test(passkeyMsg)
          ? "text-[12px] text-error"
          : "text-[12px] text-online"}
      >
        {passkeyMsg}
      </span>
    {/if}
  </div>
{/if}

<div class="flex items-center gap-3">
  <button
    type="button"
    onclick={handleSave}
    disabled={saving}
    class="rounded-md bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 transition-colors"
  >
    {saving ? "Saving..." : "Save"}
  </button>
  {#if profileMsg}
    <span class={profileMsg.includes("Failed") ? "text-[13px] text-error" : "text-[13px] text-online"}>
      {profileMsg}
    </span>
  {/if}
</div>
