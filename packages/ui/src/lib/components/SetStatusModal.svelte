<script lang="ts">
  import EmojiPicker from "$lib/components/composer/EmojiPicker.svelte";

  let {
    open,
    workspaceName = "",
    currentEmoji = null,
    currentText = null,
    currentExpiresAt = null,
    onSave,
    onClose,
  }: {
    open: boolean;
    workspaceName?: string;
    currentEmoji?: string | null;
    currentText?: string | null;
    currentExpiresAt?: string | null;
    onSave: (emoji: string | null, text: string | null, expiresAt: string | null) => void;
    onClose: () => void;
  } = $props();

  interface DurationOption { label: string; value: string }

  const DURATIONS: DurationOption[] = [
    { label: "Don't clear", value: "none" },
    { label: "30 minutes", value: "30m" },
    { label: "1 hour", value: "1h" },
    { label: "4 hours", value: "4h" },
    { label: "Today", value: "today" },
    { label: "This week", value: "this_week" },
    { label: "Choose date and time...", value: "custom" },
  ];

  interface Preset { emoji: string; text: string; defaultDuration: string }

  const DEFAULT_PRESETS: Preset[] = [
    { emoji: "\u{1F4C5}", text: "In a meeting", defaultDuration: "1h" },
    { emoji: "\u{1F68C}", text: "Commuting", defaultDuration: "30m" },
    { emoji: "\u{1F912}", text: "Out sick", defaultDuration: "today" },
    { emoji: "\u{1F334}", text: "Vacationing", defaultDuration: "none" },
    { emoji: "\u{1F3E0}", text: "Working remotely", defaultDuration: "today" },
  ];

  interface RecentStatus { emoji: string; text: string; duration: string }

  const RECENT_KEY = "cyborg7_recent_statuses";

  function getRecentStatuses(): RecentStatus[] {
    if (typeof localStorage === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 5);
    } catch { return []; }
  }

  function trackStatus(emoji: string, text: string, dur: string) {
    if (!emoji && !text) return;
    try {
      const list: RecentStatus[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      const entry: RecentStatus = { emoji, text, duration: dur };
      const filtered = list.filter((s) => !(s.emoji === emoji && s.text === text));
      const updated = [entry, ...filtered].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch { /* noop */ }
  }

  function durationToExpiresAt(d: string): string | null {
    if (!d || d === "none" || d === "custom") return null;
    const now = new Date();
    switch (d) {
      case "30m": return new Date(now.getTime() + 30 * 60_000).toISOString();
      case "1h": return new Date(now.getTime() + 60 * 60_000).toISOString();
      case "4h": return new Date(now.getTime() + 4 * 60 * 60_000).toISOString();
      case "today": {
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        return end.toISOString();
      }
      case "this_week": {
        const end = new Date(now);
        const daysUntilSunday = (7 - end.getDay()) % 7 || 7;
        end.setDate(end.getDate() + daysUntilSunday);
        end.setHours(0, 0, 0, 0);
        return end.toISOString();
      }
      default: return null;
    }
  }

  function expiresAtToClosestDuration(expiresAt: string | null | undefined): string {
    if (!expiresAt) return "none";
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return "none";
    const mins = diff / 60_000;
    if (mins <= 45) return "30m";
    if (mins <= 150) return "1h";
    if (mins <= 360) return "4h";
    if (mins <= 1440) return "today";
    return "this_week";
  }

  function formatTimeHint(d: string): string {
    const expires = durationToExpiresAt(d);
    if (!expires) return "";
    const date = new Date(expires);
    const now = new Date();
    const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (d === "today") return timeStr;
    if (d === "this_week") {
      return date.toLocaleDateString([], { weekday: "long" });
    }
    if (date.getDate() !== now.getDate()) {
      return `${date.toLocaleDateString([], { weekday: "short" })} ${timeStr}`;
    }
    return timeStr;
  }

  function durationLabel(d: string): string {
    if (d === "custom") return "Custom";
    return DURATIONS.find((o) => o.value === d)?.label ?? "Don't clear";
  }

  let emoji = $state("");
  let text = $state("");
  let duration = $state("none");
  let customDate = $state("");
  let customTime = $state("");
  let showCustomPicker = $state(false);
  let emojiPickerOpen = $state(false);
  let durationDropdownOpen = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();
  let emojiButtonEl: HTMLButtonElement | undefined = $state();
  let durationButtonEl: HTMLButtonElement | undefined = $state();
  let pickerPos = $state({ top: 0, left: 0 });
  let dropdownPos = $state({ top: 0, left: 0, width: 0 });

  const recentStatuses = $derived(getRecentStatuses());

  $effect(() => {
    if (open) {
      emoji = currentEmoji ?? "";
      text = currentText ?? "";
      duration = expiresAtToClosestDuration(currentExpiresAt);
      customDate = "";
      customTime = "";
      showCustomPicker = false;
      emojiPickerOpen = false;
      durationDropdownOpen = false;
      setTimeout(() => inputEl?.focus(), 100);
    }
  });

  function toggleEmojiPicker() {
    if (emojiPickerOpen) {
      emojiPickerOpen = false;
      return;
    }
    if (emojiButtonEl) {
      const rect = emojiButtonEl.getBoundingClientRect();
      pickerPos = { top: rect.bottom + 4, left: rect.left };
    }
    emojiPickerOpen = true;
    durationDropdownOpen = false;
  }

  function toggleDurationDropdown() {
    if (durationDropdownOpen) {
      durationDropdownOpen = false;
      return;
    }
    if (durationButtonEl) {
      const rect = durationButtonEl.getBoundingClientRect();
      dropdownPos = { top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 240) };
    }
    durationDropdownOpen = true;
    emojiPickerOpen = false;
  }

  function selectDuration(d: string) {
    if (d === "custom") {
      durationDropdownOpen = false;
      showCustomPicker = true;
      const now = new Date();
      now.setHours(now.getHours() + 1, 0, 0, 0);
      customDate = now.toISOString().slice(0, 10);
      customTime = now.toTimeString().slice(0, 5);
      return;
    }
    duration = d;
    showCustomPicker = false;
    durationDropdownOpen = false;
  }

  function applyCustomDateTime() {
    if (!customDate || !customTime) return;
    duration = "custom";
    showCustomPicker = false;
  }

  function getExpiresAt(): string | null {
    if (duration === "custom" && customDate && customTime) {
      return new Date(`${customDate}T${customTime}`).toISOString();
    }
    return durationToExpiresAt(duration);
  }

  function getCustomLabel(): string {
    if (!customDate || !customTime) return "Custom";
    const d = new Date(`${customDate}T${customTime}`);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
           d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function handleSave() {
    const finalEmoji = emoji || null;
    const finalText = text.trim() || null;
    if (!finalEmoji && !finalText) {
      onClose();
      return;
    }
    trackStatus(finalEmoji ?? "", finalText ?? "", duration);
    onSave(finalEmoji, finalText, getExpiresAt());
    onClose();
  }

  function selectPreset(p: Preset) {
    emoji = p.emoji;
    text = p.text;
    duration = p.defaultDuration;
    showCustomPicker = false;
  }

  function selectRecent(r: RecentStatus) {
    emoji = r.emoji;
    text = r.text;
    duration = r.duration;
    showCustomPicker = false;
  }

  function handleModalClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-emoji-picker]") && !target.closest("[data-emoji-trigger]")) {
      emojiPickerOpen = false;
    }
    if (!target.closest("[data-duration-dropdown]") && !target.closest("[data-duration-trigger]")) {
      durationDropdownOpen = false;
    }
  }

  const canSave = $derived(!!emoji || !!text.trim());
  const displayDurationLabel = $derived(
    duration === "custom" ? getCustomLabel() : durationLabel(duration)
  );
  const timeHint = $derived(
    duration !== "none" && duration !== "custom" ? formatTimeHint(duration) : ""
  );
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
    onclick={handleModalClick}
    onkeydown={(e) => { if (e.key === "Escape") { emojiPickerOpen = false; durationDropdownOpen = false; onClose(); } }}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Set a status"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="absolute inset-0" style="background-color: var(--modal-overlay);" onclick={onClose}></div>

    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div
      class="relative flex max-h-[85vh] w-[440px] flex-col rounded-xl shadow-2xl"
      style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div
        class="flex shrink-0 items-center justify-between px-5 py-3.5"
        style="border-bottom: 1px solid var(--dropdown-border);"
      >
        <h2 class="text-[15px] font-bold" style="color: var(--dropdown-name);">Set a status</h2>
        <button
          type="button"
          onclick={onClose}
          class="cursor-pointer text-[18px] hover:opacity-70"
          style="color: var(--dropdown-secondary);"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <!-- Scrollable content -->
      <div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <!-- Emoji + text input -->
        <div class="flex items-center gap-2">
          <button
            bind:this={emojiButtonEl}
            data-emoji-trigger
            type="button"
            onclick={toggleEmojiPicker}
            class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[20px] transition-colors touch-target"
            style="border: 1px solid var(--dropdown-border); background-color: var(--dropdown-hover);"
          >
            {emoji || "\u{1F600}"}
          </button>
          <input
            bind:this={inputEl}
            type="text"
            bind:value={text}
            oninput={(e) => { text = (e.currentTarget as HTMLInputElement).value.slice(0, 100); }}
            placeholder="What's your status?"
            class="h-10 flex-1 rounded-lg bg-transparent px-3 text-[14px] outline-none"
            style="border: 1px solid var(--dropdown-border); color: var(--dropdown-name);"
            onkeydown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") onClose();
            }}
            maxlength={100}
          />
        </div>

        <!-- Duration selector -->
        <div>
          <div class="mb-1.5 text-[12px] font-medium" style="color: var(--dropdown-secondary);">
            Clear after
          </div>
          <button
            bind:this={durationButtonEl}
            data-duration-trigger
            type="button"
            onclick={toggleDurationDropdown}
            class="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-[13px] transition-colors"
            style="border: 1px solid var(--dropdown-border); color: var(--dropdown-name); background-color: var(--dropdown-hover);"
          >
            <span>
              {displayDurationLabel}
              {#if timeHint}
                <span class="ml-1 text-[11px]" style="color: var(--dropdown-secondary);">({timeHint})</span>
              {/if}
            </span>
            <svg class="h-3.5 w-3.5 shrink-0" style="color: var(--dropdown-secondary);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>

          <!-- Custom date/time picker (inline, below the dropdown trigger) -->
          {#if showCustomPicker}
            <div
              class="mt-2 flex items-center gap-2 rounded-lg px-3 py-2.5"
              style="border: 1px solid var(--dropdown-border); background-color: var(--dropdown-hover);"
            >
              <input
                type="date"
                bind:value={customDate}
                class="flex-1 rounded bg-transparent px-1 py-1 text-[13px] outline-none"
                style="color: var(--dropdown-name); border: 1px solid var(--dropdown-border);"
                min={new Date().toISOString().slice(0, 10)}
              />
              <input
                type="time"
                bind:value={customTime}
                class="w-[100px] rounded bg-transparent px-1 py-1 text-[13px] outline-none"
                style="color: var(--dropdown-name); border: 1px solid var(--dropdown-border);"
              />
              <button
                type="button"
                onclick={applyCustomDateTime}
                disabled={!customDate || !customTime}
                class="cursor-pointer rounded px-2 py-1 text-[12px] font-medium transition-colors disabled:opacity-40"
                style="background-color: var(--btn-primary-bg); color: var(--btn-primary-text);"
              >
                Set
              </button>
            </div>
          {/if}
        </div>

        <!-- Recent statuses -->
        {#if recentStatuses.length > 0}
          <div>
            <div class="mb-1.5 text-[12px] font-medium" style="color: var(--dropdown-secondary);">
              Recent
            </div>
            <div class="space-y-0.5">
              {#each recentStatuses as r, i (i)}
                <button
                  type="button"
                  onclick={() => selectRecent(r)}
                  class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-colors"
                  onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
                  onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
                >
                  <span class="text-[16px]">{r.emoji || "\u{1F4AC}"}</span>
                  <span class="flex-1 truncate text-[13px]" style="color: var(--dropdown-name);">{r.text || r.emoji}</span>
                  <span class="shrink-0 text-[11px]" style="color: var(--dropdown-secondary);">{durationLabel(r.duration)}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Presets -->
        <div>
          <div class="mb-1.5 text-[12px] font-medium" style="color: var(--dropdown-secondary);">
            {workspaceName ? `For ${workspaceName}` : "Suggestions"}
          </div>
          <div class="space-y-0.5">
            {#each DEFAULT_PRESETS as p, i (i)}
              <button
                type="button"
                onclick={() => selectPreset(p)}
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
                onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
              >
                <span class="text-[18px]">{p.emoji}</span>
                <span class="flex-1 truncate text-[13px]" style="color: var(--dropdown-name);">{p.text}</span>
                <span class="shrink-0 text-[11px]" style="color: var(--dropdown-secondary);">{durationLabel(p.defaultDuration)}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex shrink-0 items-center justify-end gap-2 px-5 py-3"
        style="border-top: 1px solid var(--dropdown-border);"
      >
        <button
          type="button"
          onclick={onClose}
          class="cursor-pointer rounded-lg px-4 py-2 text-[13px] transition-colors"
          style="color: var(--dropdown-name);"
          onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
          onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={handleSave}
          disabled={!canSave}
          class="cursor-pointer rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          style="background-color: var(--btn-primary-bg); color: var(--btn-primary-text);"
        >
          Save
        </button>
      </div>
    </div>

    <!-- Emoji picker (fixed position, outside card overflow) -->
    {#if emojiPickerOpen}
      <div
        data-emoji-picker
        class="fixed z-[var(--z-modal-popover)]"
        style="top: {pickerPos.top}px; left: {pickerPos.left}px;"
      >
        <EmojiPicker
          onSelect={(em) => { emoji = em; emojiPickerOpen = false; }}
          onClose={() => { emojiPickerOpen = false; }}
        />
      </div>
    {/if}

    <!-- Duration dropdown (fixed position, outside card overflow) -->
    {#if durationDropdownOpen}
      <div
        data-duration-dropdown
        class="fixed z-[var(--z-modal-popover)] rounded-lg py-1 shadow-xl"
        style="top: {dropdownPos.top}px; left: {dropdownPos.left}px; width: {dropdownPos.width}px; background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
      >
        {#each DURATIONS as d (d.value)}
          {#if d.value === "custom"}
            <div class="my-0.5" style="border-top: 1px solid var(--dropdown-border);"></div>
          {/if}
          <button
            type="button"
            onclick={() => selectDuration(d.value)}
            class="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-[13px] transition-colors"
            style="color: {duration === d.value ? 'var(--c7-accent)' : 'var(--dropdown-name)'};"
            onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
            onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
          >
            <span class="flex items-center gap-2">
              {#if duration === d.value}
                <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              {:else}
                <span class="inline-block h-3.5 w-3.5 shrink-0"></span>
              {/if}
              {d.label}
            </span>
            {#if d.value !== "none" && d.value !== "custom"}
              <span class="text-[11px]" style="color: var(--dropdown-secondary);">{formatTimeHint(d.value)}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
