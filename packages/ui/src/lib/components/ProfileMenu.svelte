<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { authState, workspaceState, userStatusState, disconnectFromServer, updateProfileImage, setMyStatus, setMyPresence, notifyClientPrefsState, connectionState } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import SetStatusModal from "$lib/components/SetStatusModal.svelte";
  import AvatarCropper from "$lib/components/AvatarCropper.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { manageSubscriptions } from "$lib/mobile/iap.js";
  import { licenseState } from "$lib/state/license.svelte.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import { preferencesState } from "$lib/state/preferences.svelte.js";

  let menuOpen = $state(false);
  let manuallyInactive = $state(false);
  let statusModalOpen = $state(false);
  let cropperOpen = $state(false);
  let cropSrc = $state<string | null>(null);
  // Prefer the persisted PG avatar (set on login) and fall back to the
  // just-uploaded optimistic one — otherwise the rail shows the "R" placeholder
  // even when the chat (which reads user.imageUrl) shows the real photo.
  const profileImage = $derived(authState.user?.imageUrl ?? authState.profileImage);
  let fileInputEl: HTMLInputElement | undefined = $state();

  const user = $derived(authState.user);
  const userName = $derived(user?.name ?? user?.email ?? "User");
  const wsId = $derived(page.params.id);
  const wsName = $derived(workspaceState.current?.name ?? "");

  const statusEmoji = $derived(userStatusState.emoji);
  const statusText = $derived(userStatusState.text);
  const statusExpiresAt = $derived(userStatusState.expiresAt);
  // Do Not Disturb (client-side): suppresses banners/sounds on this device
  // except direct @mentions. Mirrored on the notifications settings page.
  const dndActive = $derived(notifyClientPrefsState.dnd);

  // Presence auto-heal (Part C): the green "Active" dot must reflect a REAL live
  // connection, not just the local Away toggle. The self-dot was driven only by
  // `manuallyInactive`, so a half-open/zombie socket (online to me, offline to
  // everyone else) still showed green "Active". Gate green on a connected socket.
  const connected = $derived(connectionState.status === "connected");
  // The shown presence: DND wins, then a non-connected socket reads as
  // "Reconnecting…", then the manual Away toggle, else Active. Drives both the
  // dot color/animation and the label so they never disagree.
  type SelfPresence = "dnd" | "reconnecting" | "away" | "active";
  const selfPresence = $derived<SelfPresence>(
    dndActive ? "dnd" : !connected ? "reconnecting" : manuallyInactive ? "away" : "active",
  );
  // Dot color token for each state. Reconnecting reuses the existing amber
  // `--color-warning` token (bg-warning) — no new visual language — paired with
  // animate-pulse so it reads as "in progress", distinct from a steady Away grey.
  const selfDotClass = $derived(
    selfPresence === "dnd"
      ? "bg-error"
      : selfPresence === "reconnecting"
        ? "bg-warning animate-pulse"
        : selfPresence === "away"
          ? "bg-content-muted"
          : "bg-online",
  );
  const selfLabel = $derived(
    selfPresence === "dnd"
      ? "Do Not Disturb"
      : selfPresence === "reconnecting"
        ? "Reconnecting…"
        : selfPresence === "away"
          ? "Away"
          : "Active",
  );

  const expiryLabel = $derived.by(() => {
    if (!statusExpiresAt) return "";
    const remaining = new Date(statusExpiresAt).getTime() - Date.now();
    if (remaining <= 0) return "";
    const mins = remaining / 60_000;
    if (mins < 60) return `${Math.ceil(mins)} min`;
    const hours = mins / 60;
    if (hours < 24) {
      const expiryDate = new Date(statusExpiresAt);
      return `until ${expiryDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    const expiryDate = new Date(statusExpiresAt);
    return `until ${expiryDate.toLocaleDateString([], { weekday: "short" })} ${expiryDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  });

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as Node;
    const el = document.getElementById("profile-menu-area");
    if (menuOpen && el && !el.contains(target)) {
      menuOpen = false;
    }
  }

  function togglePresence() {
    manuallyInactive = !manuallyInactive;
    // P2 Item 6: sync the away state to the relay so co-members see it (was
    // local-only before, so "Set yourself as away" never reached other users).
    setMyPresence(manuallyInactive);
    menuOpen = false;
  }

  function toggleTheme() {
    // When the current preference is "system", toggling switches to the
    // opposite of the RESOLVED value (e.g. OS=dark → switch to "light").
    // This makes the toggle feel predictable: tapping "Switch to Light mode"
    // always lands on light, regardless of whether we arrived via "system".
    const next = preferencesState.resolvedTheme === "dark" ? "light" : "dark";
    preferencesState.setTheme(next);
    menuOpen = false;
  }

  function handleSignOut() {
    menuOpen = false;
    disconnectFromServer();
    goto("/login");
  }

  function openStatusModal() {
    menuOpen = false;
    statusModalOpen = true;
  }

  function handleStatusSave(emoji: string | null, text: string | null, expiresAt: string | null) {
    // Sync to the relay before/while updating locally so co-members see it.
    setMyStatus(emoji, text, expiresAt);
  }

  function clearStatus() {
    // Clearing is a status set to null/null — syncs the clear to co-members too.
    setMyStatus(null, null, null);
    userStatusState.clearStatus();
  }

  function handleProfileUpload() {
    menuOpen = false;
    fileInputEl?.click();
  }

  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;

    // Don't upload the raw file — open the cropper so the user can frame/zoom
    // (Slack-style) and we upload the cropped 256×256 result.
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      cropSrc = reader.result as string;
      cropperOpen = true;
    });
    reader.readAsDataURL(file);
    input.value = "";
  }

  // The cropper hands back the framed 256×256 JPEG plus a local preview. Upload
  // the blob to S3 / persist its URL in PG so other members see it; show the
  // preview optimistically meanwhile.
  function handleCropSave(blob: Blob, preview: string): void {
    cropperOpen = false;
    cropSrc = null;
    authState.setProfileImage(preview);
    const upload = new File([blob], "avatar.jpg", { type: "image/jpeg" });
    void updateProfileImage(upload).catch(() => {
      // Upload failed — keep the optimistic preview; it'll resync on reload.
    });
  }

  // Derive the label from the RESOLVED theme (dark or light) so the button
  // always shows the opposite, even when preference is "system". Reactive:
  // an OS switch while preference=system will update the label live.
  const currentTheme = $derived(preferencesState.resolvedTheme);
</script>

<svelte:document onclick={handleClickOutside} />

<input
  bind:this={fileInputEl}
  type="file"
  accept="image/*"
  class="hidden"
  onchange={handleFileChange}
/>

<div class="relative flex items-center justify-center" id="profile-menu-area">
  <button
    type="button"
    onclick={() => (menuOpen = !menuOpen)}
    title={userName}
    class="relative h-9 w-9 cursor-pointer focus-ring touch-target"
    aria-label={`Profile menu for ${userName}`}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
  >
    <Avatar
      name={userName}
      width={36}
      borderRadius={8}
      fontSize={20}
      fontWeight={700}
      image={profileImage}
    />
    {#if dndActive}
      <!-- DND indicator takes priority over the status emoji / presence dot:
           a red "minus" badge (Slack/Mattermost-style do-not-disturb). -->
      <span
        class="absolute -bottom-[3px] -right-[3px] flex h-3.5 w-3.5 items-center justify-center rounded-full bg-error"
        style="box-shadow: 0 0 0 2px var(--bg-base);"
        title="Do Not Disturb"
        aria-label="Do Not Disturb"
      >
        <span class="block h-[2px] w-[7px] rounded-full bg-white"></span>
      </span>
    {:else if statusEmoji}
      <span
        class="absolute -bottom-[3px] -right-[3px] flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] leading-none"
        style="background-color: var(--bg-base);"
        title={userStatusState.tooltip}
      >{statusEmoji}</span>
    {:else}
      <span
        class="absolute -bottom-[3px] -right-[3px] flex h-3.5 w-3.5 items-center justify-center rounded-full"
        style="background-color: var(--bg-base);"
        role="img"
        aria-label={selfLabel}
        title={selfLabel}
      >
        <div class={cn("h-[8.5px] w-[8.5px] rounded-full", selfDotClass)}></div>
      </span>
    {/if}
  </button>

  {#if menuOpen && !viewportState.isMobile}
    <!-- Desktop: dropdown at the bottom of the rail → open upward, left-aligned.
         (Mobile renders the iOS sheet below instead — see the MobileSheet.) -->
    <div
      role="menu"
      aria-label="Profile menu"
      class="absolute top-11 right-0 sm:top-auto sm:bottom-12 sm:left-0 sm:right-auto z-[var(--z-menu)] w-[280px] rounded-lg py-1 shadow-2xl"
      style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
    >
      <!-- Header -->
      <div
        class="flex items-center gap-3 px-4 py-3"
        style="border-bottom: 1px solid var(--dropdown-border);"
      >
        <button
          type="button"
          onclick={handleProfileUpload}
          class="group relative shrink-0 cursor-pointer"
          aria-label="Change profile photo"
          title="Change profile photo"
        >
          <Avatar
            name={userName}
            width={44}
            borderRadius={10}
            fontSize={18}
            fontWeight={700}
            image={profileImage}
          />
          <!-- Hover overlay: a camera hint so it reads as "click to change photo". -->
          <span
            class="absolute inset-0 flex items-center justify-center rounded-[10px] bg-black/55 text-accent-foreground opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </span>
          <span
            class="absolute -bottom-[2px] -right-[2px] flex h-3.5 w-3.5 items-center justify-center rounded-full"
            style="background-color: var(--dropdown-bg);"
            title={selfLabel}
          >
            <div class={cn("h-[9px] w-[9px] rounded-full", selfDotClass)}></div>
          </span>
        </button>
        <div class="min-w-0">
          <div class="truncate text-[15px] font-bold" style="color: var(--dropdown-name);">{userName}</div>
          <div class="flex items-center gap-1 text-[12px]" style="color: var(--dropdown-secondary);">
            <span class={cn("inline-block h-[7px] w-[7px] rounded-full", selfDotClass)}></span>
            {selfLabel}
          </div>
        </div>
      </div>

      <!-- Status row -->
      <div class="px-2 py-1.5" style="border-bottom: 1px solid var(--dropdown-border);">
        {#if statusEmoji || statusText}
          <div
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:brightness-110 focus-ring"
            style="background-color: var(--bg-raised);"
            onclick={openStatusModal}
            role="button"
            tabindex="0"
            aria-label="Edit your status"
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openStatusModal(); } }}
          >
            <span class="text-[16px]">{statusEmoji || "\u{1F4AC}"}</span>
            <div class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-content">{statusText || statusEmoji}</span>
              {#if expiryLabel}
                <span class="block truncate text-[11px] text-content-muted">{expiryLabel}</span>
              {/if}
            </div>
            <button
              type="button"
              onclick={(e) => { e.stopPropagation(); clearStatus(); }}
              class="cursor-pointer px-1 text-[14px] text-content-muted hover:text-content focus-ring"
              aria-label="Clear status"
            >
              &times;
            </button>
          </div>
        {:else}
          <button
            type="button"
            onclick={openStatusModal}
            class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised focus-ring"
          >
            <span class="text-[16px]">{"\u{1F600}"}</span>
            <span class="text-[13px] text-content-muted">Update your status</span>
          </button>
        {/if}
      </div>

      <!-- Presence toggle -->
      <button
        type="button"
        role="menuitem"
        onclick={togglePresence}
        class="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors hover:bg-[var(--dropdown-hover)] focus-ring"
        style="color: var(--text-primary);"
      >
        <span class={cn("h-[8px] w-[8px] rounded-full", manuallyInactive ? "bg-online" : "bg-content-muted")} aria-hidden="true"></span>
        {manuallyInactive ? "Set yourself as active" : "Set yourself as away"}
      </button>

      <!-- Pause notifications (DND) moved to Settings → Notifications. -->

      <div class="my-1" style="border-top: 1px solid var(--dropdown-border);"></div>

      <!-- Theme toggle -->
      <button
        type="button"
        role="menuitem"
        onclick={toggleTheme}
        class="w-full cursor-pointer px-4 py-2 text-left text-[13px] transition-colors hover:bg-[var(--dropdown-hover)] focus-ring"
        style="color: var(--text-primary);"
      >
        {currentTheme === "light" ? "Switch to Dark mode" : "Switch to Light mode"}
      </button>

      <!-- Settings (mobile only — desktop has it in the left rail). Moved here so
           the mobile bottom nav can hold the 5 core tabs (Home·Chats·Agents·DMs·
           Activity); Settings lives in the profile menu instead (W3 redesign). -->
      {#if viewportState.isMobile}
        <button
          type="button"
          onclick={() => {
            const id = workspaceState.current?.id ?? page.params.id;
            menuOpen = false;
            if (id) goto(`/workspace/${id}/settings`);
          }}
          role="menuitem"
          class="w-full cursor-pointer px-4 py-2 text-left text-[13px] transition-colors hover:bg-[var(--dropdown-hover)] focus-ring"
          style="color: var(--text-primary);"
        >
          Settings
        </button>
      {/if}

      <!-- Manage subscription (iOS active subscribers). Opens Apple's account
           subscriptions surface — Apple requires subscription management to go
           through Apple, not our UI. Web/desktop manage via Stripe elsewhere. -->
      {#if isTauriIOS() && licenseState.state === "active"}
        <button
          type="button"
          onclick={() => {
            menuOpen = false;
            void manageSubscriptions();
          }}
          class="w-full cursor-pointer px-4 py-2 text-left text-[13px] transition-colors hover:bg-[var(--dropdown-hover)]"
          style="color: var(--text-primary);"
        >
          Manage subscription
        </button>
      {/if}

      <div class="my-1" style="border-top: 1px solid var(--dropdown-border);"></div>

      <!-- Sign out -->
      <button
        type="button"
        onclick={handleSignOut}
        class="w-full cursor-pointer px-4 py-2 text-left text-[13px] text-error transition-colors hover:bg-error/10"
      >
        Sign out{wsName ? ` of ${wsName}` : ""}
      </button>
    </div>
  {/if}

  {#if menuOpen && viewportState.isMobile}
    <!-- Mobile: the dropdown becomes an iOS bottom sheet. Same handlers as the
         desktop menu — profile header, status (inline editor via SetStatusModal),
         away, DND, theme, Settings, Manage subscription, red Sign out. -->
    <MobileSheet open={menuOpen} ariaLabel="Profile menu" onclose={() => (menuOpen = false)}>
      <!-- Header -->
      <div class="flex items-center gap-3 pb-3">
        <button
          type="button"
          onclick={handleProfileUpload}
          class="group relative shrink-0 cursor-pointer"
          aria-label="Change profile photo"
          title="Change profile photo"
        >
          <Avatar name={userName} width={48} borderRadius={12} fontSize={20} fontWeight={700} image={profileImage} />
          <span
            class="absolute inset-0 flex items-center justify-center rounded-[12px] bg-black/55 text-accent-foreground opacity-0 transition-opacity group-active:opacity-100"
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </span>
          <!-- Presence dot on the photo removed — the "● Active" row below the
               name is the single source of presence (was showing twice). -->
        </button>
        <div class="min-w-0">
          <div class="truncate text-[17px] font-bold text-content">{userName}</div>
          <div class="flex items-center gap-1.5 text-[13px] text-content-dim">
            <span class={cn("inline-block h-[7px] w-[7px] rounded-full", dndActive ? "bg-error" : manuallyInactive ? "bg-content-muted" : "bg-online")}></span>
            {dndActive ? "Do Not Disturb" : manuallyInactive ? "Away" : "Active"}
          </div>
        </div>
      </div>

      <!-- Status editor row (opens the SetStatusModal sub-flow) -->
      <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
        {#if statusEmoji || statusText}
          <div
            class="flex min-h-[48px] cursor-pointer items-center gap-3 px-4"
            onclick={openStatusModal}
            role="button"
            tabindex="0"
            aria-label="Edit your status"
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openStatusModal(); } }}
          >
            <span class="text-[18px]">{statusEmoji || "\u{1F4AC}"}</span>
            <div class="min-w-0 flex-1">
              <span class="block truncate text-[16px] text-content">{statusText || statusEmoji}</span>
              {#if expiryLabel}
                <span class="block truncate text-[12px] text-content-muted">{expiryLabel}</span>
              {/if}
            </div>
            <button
              type="button"
              onclick={(e) => { e.stopPropagation(); clearStatus(); }}
              class="px-2 text-[18px] text-content-muted active:text-content"
              aria-label="Clear status"
            >
              &times;
            </button>
          </div>
        {:else}
          <button
            type="button"
            onclick={openStatusModal}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-raised"
          >
            <span class="text-[18px]">{"\u{1F600}"}</span>
            <span class="text-[16px] text-content-muted">Update your status</span>
          </button>
        {/if}
      </div>

      <!-- Presence (Away) + Pause notifications (DND) moved to Settings. -->

      <!-- Daemon moved to its own bottom-nav tab (next to Team). -->

      <!-- Theme + Settings + Manage subscription group -->
      <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
        <button
          type="button"
          onclick={toggleTheme}
          class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised"
        >
          {currentTheme === "light" ? "Switch to Dark mode" : "Switch to Light mode"}
        </button>

        <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
        <button
          type="button"
          onclick={() => {
            const id = workspaceState.current?.id ?? page.params.id;
            menuOpen = false;
            if (id) goto(`/workspace/${id}/settings`);
          }}
          class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised"
        >
          Settings
        </button>
      </div>

      <!-- Manage subscription + Sign out moved to the Settings tab. -->
    </MobileSheet>
  {/if}
</div>

<SetStatusModal
  open={statusModalOpen}
  workspaceName={wsName}
  currentEmoji={statusEmoji}
  currentText={statusText}
  currentExpiresAt={statusExpiresAt}
  onSave={handleStatusSave}
  onClose={() => { statusModalOpen = false; }}
/>

<AvatarCropper
  open={cropperOpen}
  src={cropSrc}
  onSave={handleCropSave}
  onCancel={() => { cropperOpen = false; cropSrc = null; }}
/>
