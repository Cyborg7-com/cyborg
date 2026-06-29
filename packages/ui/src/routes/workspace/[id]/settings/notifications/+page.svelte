<script lang="ts">
  import { notificationState, workspaceState, activityState, unreadFlagState, notifPrefsState, setChannelNotificationPref, authState, notifyClientPrefsState, SOUND_CHOICES } from "$lib/state/app.svelte.js";
  import type { SoundChoice } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { isPushSupported, enableWebPush, disableWebPush, ensureWebPushSubscription } from "$lib/push/web-push.js";
  import { playNotificationSound, playNamedSound } from "$lib/notify-sound.js";
  import { cn, isDesktopApp } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  // Electron's renderer reports Notification.permission === "granted" under the
  // custom cyborg:// protocol REGARDLESS of the real macOS/Windows "Allow
  // notifications" switch, and Electron has no API to read that OS-level
  // authorization. So on desktop the permission is NOT a truthful status — we
  // show an honest "managed by your OS" state + a deep link instead. On the web,
  // Notification.permission IS accurate, so the web path is unchanged.
  const isDesktop = isDesktopApp();
  const desktopPlatform = (window as unknown as {
    cyborg7Desktop?: { platform?: "darwin" | "win32" | "linux" };
  })?.cyborg7Desktop?.platform;
  // Human OS name for copy ("macOS"/"Windows"), or a generic fallback.
  const osNameMap: Record<string, string> = { darwin: "macOS", win32: "Windows" };
  const osName = (desktopPlatform && osNameMap[desktopPlatform]) || "your operating system";

  // In-flight guard: openExternal spawns an OS window, so a rapid double-click
  // could fire it twice. Mirrors the `enabling`/`testSending` guards below.
  let openingSettings = $state(false);
  async function openNotificationSettings() {
    if (openingSettings) return;
    openingSettings = true;
    try {
      await (window as unknown as {
        cyborg7Desktop?: { openNotificationSettings?: () => Promise<void> };
      })?.cyborg7Desktop?.openNotificationSettings?.();
    } finally {
      openingSettings = false;
    }
  }

  // Per-conversation notification levels. Mirrors the channel right-click menu
  // (ChannelContextMenu) but surfaces every channel + DM in one place. Channels
  // support 3 levels; DMs are all-or-muted (mentions don't apply to a 1:1 thread).
  const channelsList = $derived(workspaceState.channels);
  const dmMembers = $derived(
    workspaceState.members.filter((m) => m.userId !== authState.user?.id),
  );
  const CHANNEL_PREF_OPTS = [
    { value: "all", label: "All" },
    { value: "mentions_only", label: "Mentions" },
    { value: "muted", label: "Muted" },
  ] as const;
  const DM_PREF_OPTS = [
    { value: "all", label: "All" },
    { value: "muted", label: "Muted" },
  ] as const;

  const wsId = $derived(workspaceState.current?.id);
  // Red-badge total: per-channel MENTION counts + per-DM message counts.
  const wsTotal = $derived(wsId ? notificationState.getWorkspaceTotal(wsId) : 0);
  // Bold-flag total: channels with ANY unread message (a plain unread doesn't
  // produce a red badge, so without this row the summary reads 0 while the
  // sidebar shows bold channels — which looked like a hardcoded counter).
  const unreadChannels = $derived(
    wsId ? workspaceState.channels.filter((c) => unreadFlagState.isUnread(wsId, c.id)).length : 0,
  );
  const activityUnread = $derived(activityState.unreadCount);
  const globalTotal = $derived(notificationState.globalTotal);

  // Two distinct capabilities, detected separately:
  //  - Notification API: OS banners. Available in browsers AND Electron
  //    (Chromium ships it under cyborg:// too).
  //  - Web Push (service worker): background delivery while the app is closed.
  //    Unsupported under Electron's cyborg:// — the old page keyed EVERYTHING
  //    on this, so Electron showed "Not supported" and hid the test buttons.
  let notifSupported = $state(false);
  let pushSupported = $state(false);
  let notifPermission = $state<NotificationPermission>("default");
  let enabling = $state(false);
  let testSending = $state(false);
  let soundPlayed = $state(false);
  // Desktop only: after a test fires we can't know if the OS actually showed it
  // (the permission is opaque), so we surface a transient "don't see it?" hint
  // with a deep link instead of leaving the user with silent nothing.
  let desktopTestHint = $state(false);
  // Browser permission can't be revoked from JS — "Turn off" unsubscribes the
  // background push. Track that separately so the row reflects it honestly
  // instead of faking notifPermission back to "default".
  let pushOff = $state(false);

  $effect(() => {
    notifSupported = typeof window !== "undefined" && "Notification" in window;
    pushSupported = isPushSupported();
    if (notifSupported) notifPermission = Notification.permission;
    // Re-register the background-push subscription with the relay if granted.
    if (pushSupported && notifSupported && Notification.permission === "granted") {
      // intentional: opportunistic push re-register on mount; the "Turn on" toggle below surfaces errors directly on retry.
      ensureWebPushSubscription().catch(() => {});
    }
  });

  async function requestNotifPermission() {
    if (!notifSupported || enabling) return;
    enabling = true;
    try {
      // Web path: permission + push subscription in one flow. Electron path:
      // plain Notification permission (banners fire while the app runs).
      notifPermission = pushSupported
        ? await enableWebPush()
        : await Notification.requestPermission();
      pushOff = false;
    } catch (err) {
      console.warn("Notifications: enable failed", err);
    } finally {
      enabling = false;
    }
  }

  async function turnOffNotifications() {
    if (!pushSupported) return;
    try {
      await disableWebPush();
      pushOff = true;
    } catch (err) {
      console.warn("Notifications: disable failed", err);
    }
  }

  function sendTestNotification(type: "mention" | "dm" | "agent") {
    // Web: the permission is accurate, so gate on it (buttons are also disabled).
    // Desktop: the permission is opaque under cyborg://, so we always attempt and
    // show a guidance hint afterward — the OS switch may silently swallow it.
    if (!isDesktop && notifPermission !== "granted") return;
    testSending = true;
    const titles: Record<string, string> = {
      mention: "Test Mention",
      dm: "Test Direct Message",
      agent: "Test Agent Alert",
    };
    const bodies: Record<string, string> = {
      mention: "@you was mentioned in #general",
      dm: "New message from a teammate",
      agent: "Agent requests permission to run a tool",
    };
    const desktopNotify = (window as unknown as {
      cyborg7Desktop?: { notify?: (o: { title: string; body: string; url?: string }) => void };
    })?.cyborg7Desktop?.notify;
    if (isDesktop && desktopNotify) {
      // Native main-process notification (richer + more reliable than the
      // renderer's web Notification under cyborg://; mirrors real chat alerts).
      desktopNotify({ title: titles[type], body: bodies[type] });
      desktopTestHint = true;
    } else {
      void new Notification(titles[type], {
        body: bodies[type],
        icon: "/favicon.png",
        tag: `cyborg7-test-${type}`,
      });
    }
    setTimeout(() => { testSending = false; }, 1000);
  }

  function testSound() {
    // The click itself is the user gesture, so play() succeeds directly — no
    // unlock step needed (its async volume-0 play/pause could race this one).
    playNotificationSound();
    soundPlayed = true;
    setTimeout(() => { soundPlayed = false; }, 1500);
  }

  function clearAllNotifications() {
    if (wsId) notificationState.clearWorkspace(wsId);
    activityState.markAllRead();
  }

  // ─── Client-side notification prefs (this device only) ───────────────
  // DND, custom highlight keywords, per-channel ignore-broadcast + sound. These
  // gate the client notify policy + sound (notifyClientPrefsState) and never
  // touch the server-backed per-conversation levels above.
  const dndActive = $derived(notifyClientPrefsState.dnd);
  const keywords = $derived(notifyClientPrefsState.keywords);

  let keywordDraft = $state("");

  function addKeyword() {
    // Split on commas so pasting "urgent, deploy, blocker" yields three chips
    // instead of one. addKeyword() already case-insensitively dedupes each token
    // against the existing keywords and skips empties.
    const tokens = keywordDraft
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return;
    for (const token of tokens) {
      notifyClientPrefsState.addKeyword(token);
    }
    keywordDraft = "";
  }

  function onKeywordKeydown(e: KeyboardEvent) {
    // Enter or comma commits the chip (comma is a common keyword separator).
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword();
    } else if (e.key === "Backspace" && keywordDraft === "" && keywords.length > 0) {
      // Backspace on an empty field removes the last chip (chip-input convention).
      notifyClientPrefsState.removeKeyword(keywords[keywords.length - 1]);
    }
  }

  const SOUND_LABELS: Record<SoundChoice, string> = Object.fromEntries(
    SOUND_CHOICES.map((s) => [s.value, s.label]),
  ) as Record<SoundChoice, string>;

  function onChannelSoundChange(channelId: string, value: string | undefined) {
    if (!value) return;
    const choice = value as SoundChoice;
    notifyClientPrefsState.setChannelSound(channelId, choice);
    // Preview the picked sound so the user hears the difference immediately.
    playNamedSound(choice);
  }
</script>

{#if viewportState.isMobile}
  <!-- ── Mobile: iOS grouped inset cards ── -->
  <div class="px-4 pb-8 pt-3 space-y-6">

    <!-- Push Notifications (first: this is the master on/off the rest depends on) -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Push Notifications
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[48px] items-center gap-3 px-[16px] py-[12px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Desktop notifications</p>
            <p class="mt-0.5 text-[13px] leading-snug text-content-muted">
              {#if isDesktop}
                Banners are controlled by {osName}.
              {:else if !notifSupported}
                Not supported in this environment
              {:else if notifPermission === "granted" && pushOff}
                Push unsubscribed — re-enable to receive notifications
              {:else if notifPermission === "granted"}
                Enabled
              {:else if notifPermission === "denied"}
                Blocked — update in browser/system settings
              {:else}
                Tap to enable desktop notifications
              {/if}
            </p>
          </div>
          {#if isDesktop}
            <!-- Desktop: Notification.permission is always "granted" under
                 cyborg:// and Electron can't read the OS switch, so NEVER show a
                 green "Active" (it would lie). Neutral "System" pill + a deep
                 link to the OS settings the user actually controls. -->
            <span class="flex h-6 shrink-0 items-center rounded-full bg-surface px-2.5 text-[12px] font-medium text-content-muted">
              System
            </span>
          {:else if notifSupported && (notifPermission === "default" || pushOff)}
            <button
              type="button"
              disabled={enabling}
              onclick={requestNotifPermission}
              class="pressable shrink-0 rounded-[8px] bg-btn-primary-bg px-3 py-1.5 text-[14px] font-medium text-btn-primary-text disabled:opacity-50 focus-ring"
            >
              {enabling ? "Enabling..." : pushOff ? "Re-enable" : "Enable"}
            </button>
          {:else if notifPermission === "granted"}
            <div class="flex items-center gap-2">
              <span class="flex h-6 items-center rounded-full bg-online/20 px-2.5 text-[12px] font-medium text-online">
                Active
              </span>
              {#if pushSupported}
                <button
                  type="button"
                  onclick={turnOffNotifications}
                  class="pressable rounded-[8px] border border-edge px-3 py-1.5 text-[14px] text-content-muted focus-ring"
                >
                  Turn off
                </button>
              {/if}
            </div>
          {:else if notifPermission === "denied"}
            <span class="flex h-6 items-center rounded-full bg-error/20 px-2.5 text-[12px] font-medium text-error">
              Blocked
            </span>
          {/if}
        </div>
        {#if isDesktop}
          <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
          <div class="px-[16px] py-[12px] space-y-2.5">
            <p class="text-[13px] leading-snug text-content-muted">
              Cyborg can't toggle this for you — open Settings, enable it, then send a test below.
            </p>
            <button
              type="button"
              disabled={openingSettings}
              onclick={openNotificationSettings}
              class="pressable rounded-[8px] bg-btn-primary-bg px-3 py-1.5 text-[14px] font-medium text-btn-primary-text disabled:opacity-50 focus-ring"
            >
              {openingSettings ? "Opening..." : "Open notification settings"}
            </button>
          </div>
        {/if}
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Background push</p>
            <p class="mt-0.5 text-[13px] text-content-muted">
              {#if pushSupported}
                Delivers notifications while the app is closed
              {:else}
                Unavailable — banners fire while the app is open
              {/if}
            </p>
          </div>
          <span
            class="ml-3 flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-medium {pushSupported
              ? 'bg-online/20 text-online'
              : 'bg-surface text-content-muted'}"
          >
            {pushSupported ? "Available" : "N/A"}
          </span>
        </div>
      </div>
    </div>

    <!-- Do Not Disturb -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Do Not Disturb
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[48px] items-center gap-4 px-[16px] py-[12px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Pause notifications</p>
            <p class="mt-0.5 text-[13px] leading-snug text-content-muted">
              Silences banners and sounds on this device. Direct &commat;mentions still come through.
            </p>
          </div>
          <Switch
            checked={dndActive}
            onCheckedChange={(v) => notifyClientPrefsState.setDnd(v)}
            aria-label="Toggle Do Not Disturb"
          />
        </div>
      </div>
      {#if dndActive}
        <p class="mt-2 px-[4px] text-[13px] font-medium text-error">
          Do Not Disturb is on — most notifications are paused on this device.
        </p>
      {/if}
    </div>

    <!-- Highlight keywords -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Highlight Keywords
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[12px] space-y-3">
        <p class="text-[13px] leading-snug text-content-muted">
          Notified when a message contains any of these words. Whole-word, case-insensitive. Stored on this device only.
        </p>
        {#if keywords.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each keywords as kw (kw)}
              <span class="flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-[13px] font-medium text-content">
                {kw}
                <button
                  type="button"
                  onclick={() => notifyClientPrefsState.removeKeyword(kw)}
                  class="flex h-[20px] w-[20px] items-center justify-center rounded-full text-content-muted"
                  aria-label={`Remove keyword ${kw}`}
                >
                  <span class="text-[14px] leading-none">&times;</span>
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-2">
          <input
            bind:value={keywordDraft}
            onkeydown={onKeywordKeydown}
            placeholder="Add a keyword (e.g. urgent, deploy)…"
            class="h-[44px] flex-1 rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content placeholder:text-content-muted outline-none focus:border-accent"
            aria-label="Add highlight keyword"
          />
          <button
            type="button"
            disabled={!keywordDraft.trim()}
            onclick={addKeyword}
            class="pressable h-[44px] shrink-0 rounded-[10px] bg-btn-primary-bg px-4 text-[15px] font-medium text-btn-primary-text disabled:opacity-40 focus-ring"
          >
            Add
          </button>
        </div>
        {#if keywords.length === 0}
          <p class="text-[13px] text-content-muted">No keywords yet. Press Enter or comma to add one.</p>
        {/if}
      </div>
    </div>

    <!-- Unread Summary -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Unread Summary
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Mention &amp; DM badges</span>
          <span class="text-[16px] font-medium tabular-nums text-content">{wsTotal}</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Channels with unread</span>
          <span class="text-[16px] font-medium tabular-nums text-content">{unreadChannels}</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[16px] text-content">Activity notifications</span>
          <span class="text-[16px] font-medium tabular-nums text-content">{activityUnread}</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
          <span class="text-[15px] text-content-muted">Global badge total</span>
          <span class="text-[16px] font-medium tabular-nums text-content">{globalTotal}</span>
        </div>
      </div>
      {#if wsTotal > 0 || activityUnread > 0}
        <div class="mt-2 overflow-hidden rounded-[14px] bg-surface-alt">
          <button
            type="button"
            onclick={clearAllNotifications}
            class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring"
          >
            <span class="text-[16px] text-accent">Clear all for this workspace</span>
          </button>
        </div>
      {/if}
    </div>

    <!-- Per-channel & DM notification levels -->
    {#if channelsList.length > 0 || dmMembers.length > 0}
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
          Per-Channel &amp; DM Notifications
        </p>
        <p class="mb-3 px-[4px] text-[13px] text-content-muted">
          Choose what notifies you for each channel and DM.
        </p>

        {#if channelsList.length > 0}
          <p class="mb-1 px-[4px] text-[12px] font-medium text-content-muted">Channels</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            {#each channelsList as channel, ci (channel.id)}
              {#if ci > 0}<div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
              {@const ignoreBroadcast = notifyClientPrefsState.ignoreBroadcastFor(channel.id)}
              {@const sound = notifyClientPrefsState.soundFor(channel.id)}
              <div class="px-[16px] py-[10px] space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <span class="min-w-0 truncate text-[16px] text-content"># {channel.name}</span>
                  <div class="flex shrink-0 items-center gap-1 rounded-[8px] bg-surface p-0.5">
                    {#each CHANNEL_PREF_OPTS as opt (opt.value)}
                      <button
                        type="button"
                        onclick={() => setChannelNotificationPref(channel.id, opt.value as "all" | "mentions_only" | "muted")}
                        class={cn(
                          "rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors",
                          notifPrefsState.get(channel.id) === opt.value
                            ? "bg-accent text-accent-foreground"
                            : "text-content-muted",
                        )}
                      >
                        {opt.label}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <label class="flex cursor-pointer items-center gap-2 text-[13px] text-content-muted">
                    <Switch
                      checked={ignoreBroadcast}
                      onCheckedChange={(v) => notifyClientPrefsState.setIgnoreBroadcast(channel.id, v)}
                      aria-label={`Ignore @channel, @here and @all in #${channel.name}`}
                    />
                    <span>Ignore &commat;channel / &commat;here</span>
                  </label>
                  <div class="flex items-center gap-2">
                    <span class="text-[13px] text-content-muted">Sound</span>
                    <Select.Root
                      type="single"
                      value={sound}
                      onValueChange={(v) => onChannelSoundChange(channel.id, v)}
                    >
                      <Select.Trigger class="h-8 min-w-[92px] text-[13px]">
                        {SOUND_LABELS[sound]}
                      </Select.Trigger>
                      <Select.Content>
                        {#each SOUND_CHOICES as s (s.value)}
                          <Select.Item value={s.value} label={s.label}>{s.label}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if dmMembers.length > 0}
          <p class="mb-1 mt-4 px-[4px] text-[12px] font-medium text-content-muted">Direct messages</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            {#each dmMembers as member, mi (member.userId)}
              {#if mi > 0}<div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
              <div class="flex min-h-[44px] items-center justify-between gap-3 px-[16px] py-[10px]">
                <span class="min-w-0 truncate text-[16px] text-content">{member.name ?? member.userId}</span>
                <div class="flex shrink-0 items-center gap-1 rounded-[8px] bg-surface p-0.5">
                  {#each DM_PREF_OPTS as opt (opt.value)}
                    <button
                      type="button"
                      onclick={() => setChannelNotificationPref(member.userId, opt.value as "all" | "muted")}
                      class={cn(
                        "rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors",
                        notifPrefsState.get(member.userId) === opt.value
                          ? "bg-accent text-accent-foreground"
                          : "text-content-muted",
                      )}
                    >
                      {opt.label}
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Test Notifications -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Test Notifications
      </p>
      <p class="mb-3 px-[4px] text-[13px] text-content-muted">
        Send a test notification or play the notification sound to verify your setup.
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <button
          type="button"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("mention")}
          class="pressable-row flex h-[48px] w-full items-center justify-between px-[16px] focus-ring disabled:opacity-40"
        >
          <span class="text-[16px] text-content">Test Mention</span>
          <svg class="h-4 w-4 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <button
          type="button"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("dm")}
          class="pressable-row flex h-[48px] w-full items-center justify-between px-[16px] focus-ring disabled:opacity-40"
        >
          <span class="text-[16px] text-content">Test DM</span>
          <svg class="h-4 w-4 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <button
          type="button"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("agent")}
          class="pressable-row flex h-[48px] w-full items-center justify-between px-[16px] focus-ring disabled:opacity-40"
        >
          <span class="text-[16px] text-content">Test Agent Alert</span>
          <svg class="h-4 w-4 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <button
          type="button"
          onclick={testSound}
          class="pressable-row flex h-[48px] w-full items-center justify-between px-[16px] focus-ring"
        >
          <span class="text-[16px] text-content">{soundPlayed ? "Playing…" : "Test sound"}</span>
          <svg class="h-4 w-4 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      {#if isDesktop && desktopTestHint}
        <p class="mt-2 px-[4px] text-[13px] leading-snug text-content-muted">
          Sent. Don't see it? Banners may be off in {osName} —
          <button
            type="button"
            onclick={openNotificationSettings}
            class="font-medium text-accent underline focus-ring"
          >
            Open notification settings →
          </button>
        </p>
      {:else if !isDesktop && notifSupported && notifPermission !== "granted"}
        <p class="mt-2 px-[4px] text-[13px] text-content-muted">
          Enable desktop notifications above to use the notification tests.
        </p>
      {/if}
    </div>

    <!-- Behavior -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">
        Behavior
      </p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <div class="flex min-h-[48px] items-center gap-3 px-[16px] py-[10px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Badge on dock icon</p>
            <p class="mt-0.5 text-[13px] text-content-muted">A dot for unread channel activity, and a count for &commat;mentions and DMs (desktop only)</p>
          </div>
          <span class="flex h-6 shrink-0 items-center rounded-full bg-online/20 px-2.5 text-[12px] font-medium text-online">Auto</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[48px] items-center gap-3 px-[16px] py-[10px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Sidebar badges</p>
            <p class="mt-0.5 text-[13px] text-content-muted">Show unread count on each channel and DM</p>
          </div>
          <span class="flex h-6 shrink-0 items-center rounded-full bg-online/20 px-2.5 text-[12px] font-medium text-online">Active</span>
        </div>
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
        <div class="flex min-h-[48px] items-center gap-3 px-[16px] py-[10px]">
          <div class="min-w-0 flex-1">
            <p class="text-[16px] text-content">Rail badges</p>
            <p class="mt-0.5 text-[13px] text-content-muted">Show aggregate unread count on Chat and Activity icons</p>
          </div>
          <span class="flex h-6 shrink-0 items-center rounded-full bg-online/20 px-2.5 text-[12px] font-medium text-online">Active</span>
        </div>
      </div>
    </div>

  </div>
{:else}
  <!-- ── Desktop: original layout (byte-equal) ── -->
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
    <header>
      <h1 class="text-lg font-semibold text-content">Notifications</h1>
      <p class="mt-1 text-xs text-content-muted">Configure how you receive notifications</p>
    </header>

    <!-- Push notifications (first: this is the master on/off the rest depends on) -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Push Notifications
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <div>
            <div class="text-sm font-medium text-content">Desktop notifications</div>
            <div class="text-[11px] text-content-dim">
              {#if isDesktop}
                Banners are controlled by {osName}.
              {:else if !notifSupported}
                Not supported in this environment
              {:else if notifPermission === "granted" && pushOff}
                Push unsubscribed — re-enable to receive notifications
              {:else if notifPermission === "granted"}
                Enabled
              {:else if notifPermission === "denied"}
                Blocked — update in browser/system settings
              {:else}
                Click to enable desktop notifications
              {/if}
            </div>
            {#if isDesktop}
              <!-- Desktop: Notification.permission is always "granted" under
                   cyborg:// and Electron can't read the OS switch, so NEVER show a
                   green "Active" (it would lie). A deep link to the OS settings the
                   user actually controls + an honest "can't toggle this" line. -->
              <div class="mt-1.5 text-[11px] text-content-dim">
                Cyborg can't toggle this for you — open Settings, enable it, then send a test below.
              </div>
            {/if}
          </div>
          {#if isDesktop}
            <div class="flex shrink-0 items-center gap-2">
              <span class="flex h-6 items-center rounded-full bg-surface-alt px-2.5 text-[11px] font-medium text-content-muted">
                System
              </span>
              <Button size="sm" variant="outline" disabled={openingSettings} onclick={openNotificationSettings}>
                {openingSettings ? "Opening..." : "Open notification settings"}
              </Button>
            </div>
          {:else if notifSupported && (notifPermission === "default" || pushOff)}
            <Button size="sm" disabled={enabling} onclick={requestNotifPermission}>
              {enabling ? "Enabling..." : pushOff ? "Re-enable" : "Enable"}
            </Button>
          {:else if notifPermission === "granted"}
            <div class="flex items-center gap-2">
              <span class="flex h-6 items-center rounded-full bg-online/20 px-2.5 text-[11px] font-medium text-online">
                Active
              </span>
              {#if pushSupported}
                <Button variant="ghost" size="sm" onclick={turnOffNotifications}>Turn off</Button>
              {/if}
            </div>
          {:else if notifPermission === "denied"}
            <span class="flex h-6 items-center rounded-full bg-error/20 px-2.5 text-[11px] font-medium text-error">
              Blocked
            </span>
          {/if}
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="text-sm font-medium text-content">Background push</div>
            <div class="text-[11px] text-content-dim">
              {#if pushSupported}
                Delivers notifications while the app is closed
              {:else}
                Unavailable here — banners fire while the app is open (the desktop
                app uses native notifications)
              {/if}
            </div>
          </div>
          <span
            class="flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium {pushSupported
              ? 'bg-online/20 text-online'
              : 'bg-surface-alt text-content-muted'}"
          >
            {pushSupported ? "Available" : "N/A"}
          </span>
        </div>
      </div>
    </section>

    <!-- Do Not Disturb (client-side, this device) -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Do Not Disturb
      </span>
      <div class="rounded-lg border border-edge">
        <div class="flex items-center justify-between px-4 py-3">
          <div class="pr-4">
            <div class="text-sm font-medium text-content">Pause notifications</div>
            <div class="text-[11px] text-content-dim">
              Silences desktop banners and sounds on this device. Direct
              &commat;mentions still come through; channel-wide &commat;here /
              &commat;channel are suppressed.
            </div>
          </div>
          <Switch
            checked={dndActive}
            onCheckedChange={(v) => notifyClientPrefsState.setDnd(v)}
            aria-label="Toggle Do Not Disturb"
          />
        </div>
      </div>
      {#if dndActive}
        <p class="text-[11px] font-medium text-error">
          Do Not Disturb is on — most notifications are paused on this device.
        </p>
      {/if}
    </section>

    <!-- Custom highlight keywords (client-side, this device) -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Highlight keywords
      </span>
      <p class="text-xs text-content-dim">
        Get notified when a message contains any of these words — beyond
        &commat;mentions of your name. Whole-word, case-insensitive. Stored on this
        device only.
      </p>
      <div class="rounded-lg border border-edge px-3 py-3 space-y-2">
        {#if keywords.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each keywords as kw (kw)}
              <span class="flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-content">
                {kw}
                <button
                  type="button"
                  onclick={() => notifyClientPrefsState.removeKeyword(kw)}
                  class="-mr-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
                  aria-label={`Remove keyword ${kw}`}
                >
                  <span class="text-[13px] leading-none">&times;</span>
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="flex items-center gap-2">
          <Input
            bind:value={keywordDraft}
            onkeydown={onKeywordKeydown}
            placeholder="Add a keyword (e.g. urgent, deploy)…"
            class="h-8 flex-1 text-[13px]"
            aria-label="Add highlight keyword"
          />
          <Button size="sm" variant="outline" disabled={!keywordDraft.trim()} onclick={addKeyword}>
            Add
          </Button>
        </div>
        {#if keywords.length === 0}
          <p class="text-[11px] text-content-dim">
            No keywords yet. Press Enter or comma to add one.
          </p>
        {/if}
      </div>
    </section>

    <!-- Current counts -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Unread Summary
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Mention & DM badges</span>
          <span class="text-sm font-medium text-content tabular-nums">{wsTotal}</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Channels with unread messages</span>
          <span class="text-sm font-medium text-content tabular-nums">{unreadChannels}</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Activity notifications</span>
          <span class="text-sm font-medium text-content tabular-nums">{activityUnread}</span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-content-dim">Global badge total (all workspaces)</span>
          <span class="text-sm font-medium text-content tabular-nums">{globalTotal}</span>
        </div>
      </div>
      {#if wsTotal > 0 || activityUnread > 0}
        <Button variant="outline" size="sm" onclick={clearAllNotifications}>
          Clear all for this workspace
        </Button>
      {/if}
    </section>

    <!-- Per-channel & per-DM notification levels -->
    {#snippet prefSelector(scopeId: string, opts: readonly { value: string; label: string }[])}
      {@const current = notifPrefsState.get(scopeId)}
      <div class="flex shrink-0 items-center gap-1">
        {#each opts as opt (opt.value)}
          <button
            type="button"
            onclick={() => setChannelNotificationPref(scopeId, opt.value as "all" | "mentions_only" | "muted")}
            class={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              current === opt.value
                ? "bg-accent text-accent-foreground"
                : "text-content-muted hover:bg-hover-gray",
            )}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    {/snippet}

    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Per-channel & DM notifications
      </span>
      <p class="text-xs text-content-dim">
        Choose what notifies you for each channel and direct message — the same options you get by right-clicking a channel in the sidebar.
      </p>

      {#if channelsList.length > 0}
        <span class="block pt-1 text-[11px] font-medium text-content-muted">Channels</span>
        <div class="rounded-lg border border-edge divide-y divide-edge">
          {#each channelsList as channel (channel.id)}
            {@const ignoreBroadcast = notifyClientPrefsState.ignoreBroadcastFor(channel.id)}
            {@const sound = notifyClientPrefsState.soundFor(channel.id)}
            <div class="px-4 py-2.5 space-y-2">
              <div class="flex items-center justify-between gap-3">
                <span class="truncate text-sm text-content-dim"># {channel.name}</span>
                {@render prefSelector(channel.id, CHANNEL_PREF_OPTS)}
              </div>
              <!-- Per-channel client-side options (this device): ignore channel-wide
                   broadcasts and pick a distinct notification sound. -->
              <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pl-0.5">
                <label class="flex cursor-pointer items-center gap-2 text-[11px] text-content-muted">
                  <Switch
                    checked={ignoreBroadcast}
                    onCheckedChange={(v) => notifyClientPrefsState.setIgnoreBroadcast(channel.id, v)}
                    aria-label={`Ignore @channel, @here and @all in #${channel.name}`}
                  />
                  <span>Ignore &commat;channel / &commat;here / &commat;all</span>
                </label>
                <div class="flex items-center gap-1.5">
                  <span class="text-[11px] text-content-muted">Sound</span>
                  <Select.Root
                    type="single"
                    value={sound}
                    onValueChange={(v) => onChannelSoundChange(channel.id, v)}
                  >
                    <Select.Trigger class="h-7 min-w-[92px] text-[11px]">
                      {SOUND_LABELS[sound]}
                    </Select.Trigger>
                    <Select.Content>
                      {#each SOUND_CHOICES as s (s.value)}
                        <Select.Item value={s.value} label={s.label}>{s.label}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if dmMembers.length > 0}
        <span class="block pt-2 text-[11px] font-medium text-content-muted">Direct messages</span>
        <div class="rounded-lg border border-edge divide-y divide-edge">
          {#each dmMembers as member (member.userId)}
            <div class="flex items-center justify-between gap-3 px-4 py-2.5">
              <span class="truncate text-sm text-content-dim">{member.name ?? member.userId}</span>
              {@render prefSelector(member.userId, DM_PREF_OPTS)}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Test notifications + sound -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Test Notifications
      </span>
      <p class="text-xs text-content-dim">
        Send a test notification or play the notification sound to verify your setup.
      </p>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("mention")}
        >
          Test Mention
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("dm")}
        >
          Test DM
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={testSending || (!isDesktop && notifPermission !== "granted")}
          onclick={() => sendTestNotification("agent")}
        >
          Test Agent Alert
        </Button>
        <Button variant="outline" size="sm" onclick={testSound}>
          {soundPlayed ? "Playing…" : "Test sound"}
        </Button>
      </div>
      {#if isDesktop && desktopTestHint}
        <p class="text-[11px] text-content-dim">
          Sent. Don't see it? Banners may be off in {osName} —
          <button
            type="button"
            onclick={openNotificationSettings}
            class="font-medium text-accent underline"
          >
            Open notification settings →
          </button>
        </p>
      {:else if !isDesktop && notifSupported && notifPermission !== "granted"}
        <p class="text-[11px] text-content-dim">
          Enable desktop notifications above to use the notification tests.
        </p>
      {/if}
    </section>

    <!-- Notification behavior -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Behavior
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="text-sm font-medium text-content">Badge on dock icon</div>
            <div class="text-[11px] text-content-dim">A dot for unread channel activity, and a count for &commat;mentions and DMs (desktop only)</div>
          </div>
          <span class="flex h-6 items-center rounded-full bg-online/20 px-2.5 text-[11px] font-medium text-online">
            Auto
          </span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="text-sm font-medium text-content">Sidebar badges</div>
            <div class="text-[11px] text-content-dim">Show unread count on each channel and DM</div>
          </div>
          <span class="flex h-6 items-center rounded-full bg-online/20 px-2.5 text-[11px] font-medium text-online">
            Active
          </span>
        </div>
        <div class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="text-sm font-medium text-content">Rail badges</div>
            <div class="text-[11px] text-content-dim">Show aggregate unread count on Chat and Activity icons</div>
          </div>
          <span class="flex h-6 items-center rounded-full bg-online/20 px-2.5 text-[11px] font-medium text-online">
            Active
          </span>
        </div>
      </div>
    </section>
  </div>
{/if}
