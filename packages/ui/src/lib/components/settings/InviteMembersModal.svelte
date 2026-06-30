<script lang="ts" module>
  // Shared email check — no validator existed in the repo, so a single pragmatic
  // regex (one @, a dot in the domain). ponytail: deliberately loose; the relay
  // is the real authority, this only flags obvious typos in the chip field.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  export function isValidEmail(value: string): boolean {
    return EMAIL_RE.test(value.trim());
  }
</script>

<script lang="ts">
  import {
    workspaceState,
    inviteMember,
    getOpenInvite,
    upsertOpenInvite,
  } from "$lib/state/app.svelte.js";
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Field, { fieldInputClass } from "$lib/components/Field.svelte";
  import * as Select from "$lib/components/ui/select/index.js";

  let {
    open = $bindable(false),
    onClose,
  }: {
    // Some callers two-way bind, others pass a one-way `open` + `onClose`.
    open: boolean;
    onClose?: () => void;
  } = $props();

  type Role = "admin" | "member" | "viewer";
  const INVITE_ROLES: { value: Role; label: string }[] = [
    { value: "member", label: "Member" },
    { value: "admin", label: "Admin" },
    { value: "viewer", label: "Viewer" },
  ];

  type Chip = { email: string; valid: boolean };
  type SendResult = {
    email: string;
    status: "sent" | "member" | "invalid" | "failed";
    message?: string;
  };

  let role = $state<Role>("member");
  const roleLabel = $derived(INVITE_ROLES.find((r) => r.value === role)?.label ?? "Member");

  // Email chip field.
  let chips = $state<Chip[]>([]);
  let draft = $state("");
  let emailInputEl = $state<HTMLInputElement | undefined>();

  // Channel multiselect.
  let channelIds = $state<string[]>([]);
  let channelSearch = $state("");
  const channels = $derived(
    workspaceState.channels.filter((c) => !c.isArchived && c.type !== "group_dm" && !c.isHidden),
  );
  const selectedChannels = $derived(channels.filter((c) => channelIds.includes(c.id)));
  const channelMatches = $derived(
    channels
      .filter((c) => !channelIds.includes(c.id))
      .filter((c) => {
        const q = channelSearch.trim().toLowerCase();
        return !q || c.name.toLowerCase().includes(q);
      }),
  );

  // Reusable invite link.
  let linkUrl = $state("");
  let linkLoading = $state(false);
  let linkBusy = $state(false);
  let linkCopied = $state(false);
  // Soft note when the new relay endpoints aren't deployed yet.
  let linkUnavailable = $state(false);
  // Message shown when the link can't be loaded: a permission denial vs the
  // not-yet-deployed endpoint read differently to the user.
  let linkErrorMsg = $state("");

  function noteLinkError(err: unknown): void {
    const raw = err instanceof Error ? err.message : "";
    linkErrorMsg =
      raw === "forbidden"
        ? "Only owners and admins can manage the invite link."
        : "Invite link available after the next app update.";
    linkUnavailable = true;
    linkUrl = "";
  }
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Send state.
  let sending = $state(false);
  let results = $state<SendResult[]>([]);

  const validChips = $derived(chips.filter((c) => c.valid));
  const sendLabel = $derived(
    validChips.length <= 1 ? "Send invite" : `Send ${validChips.length} invites`,
  );

  function close() {
    open = false;
    onClose?.();
  }

  // ─── Email chips ──────────────────────────────────────────────────

  function addChips(raw: string) {
    const parts = raw.split(/[\s,;\n]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const existing = new Set(chips.map((c) => c.email.toLowerCase()));
    const next = [...chips];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      next.push({ email: p, valid: isValidEmail(p) });
    }
    chips = next;
  }

  function commitDraft() {
    if (!draft.trim()) return;
    addChips(draft);
    draft = "";
  }

  function removeChip(email: string) {
    chips = chips.filter((c) => c.email !== email);
  }

  function onEmailKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
      chips = chips.slice(0, -1);
    }
  }

  function onEmailPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (/[\s,;\n]/.test(text)) {
      e.preventDefault();
      addChips(text);
      draft = "";
    }
  }

  // ─── Channels ─────────────────────────────────────────────────────

  function addChannel(id: string) {
    if (!channelIds.includes(id)) channelIds = [...channelIds, id];
    channelSearch = "";
  }
  function removeChannel(id: string) {
    channelIds = channelIds.filter((c) => c !== id);
  }

  // ─── Reusable link ────────────────────────────────────────────────

  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function loadLink() {
    linkLoading = true;
    linkUnavailable = false;
    try {
      const invite = await getOpenInvite();
      linkUrl = invite?.inviteUrl ?? "";
    } catch (err) {
      // Forbidden vs the new relay endpoint not being deployed yet.
      noteLinkError(err);
    } finally {
      linkLoading = false;
    }
  }

  // Create or refresh the link to reflect the currently selected role + channels.
  // rotate:true mints a new token (the Reset action).
  async function syncLink(rotate: boolean) {
    linkBusy = true;
    linkUnavailable = false;
    try {
      const invite = await upsertOpenInvite(role, channelIds, rotate);
      linkUrl = invite.inviteUrl;
      return invite.inviteUrl;
    } catch (err) {
      noteLinkError(err);
      return "";
    } finally {
      linkBusy = false;
    }
  }

  async function handleCopyLink() {
    // Reflect the current role/channels before copying.
    const url = (await syncLink(false)) || linkUrl;
    if (url && (await copyToClipboard(url))) {
      linkCopied = true;
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        linkCopied = false;
        copyTimeout = null;
      }, 2000);
    }
  }

  // ─── Send ─────────────────────────────────────────────────────────

  async function handleSend() {
    commitDraft();
    if (sending) return;
    const valid = chips.filter((c) => c.valid);
    if (valid.length === 0) return;

    sending = true;
    const sentEmails = new Set<string>();
    // Fire all invites concurrently — each is an independent RPC, so a sequential
    // await made an N-address batch feel N× slower. ponytail: unbounded fan-out is
    // fine for realistic batch sizes; add a concurrency cap if huge lists hit the
    // relay's inbound rate limit.
    const out = await Promise.all(
      valid.map(async (chip): Promise<SendResult> => {
        try {
          await inviteMember(chip.email, role, channelIds);
          sentEmails.add(chip.email);
          return { email: chip.email, status: "sent" };
        } catch (err) {
          const raw = err instanceof Error ? err.message : "Failed to send";
          if (raw === "already a member") {
            sentEmails.add(chip.email);
            return { email: chip.email, status: "member" };
          }
          if (raw === "forbidden") {
            return { email: chip.email, status: "failed", message: "Not allowed" };
          }
          return { email: chip.email, status: "failed", message: raw };
        }
      }),
    );
    results = out;
    // Keep the modal open to show results; drop successfully-handled chips so the
    // user can correct/retry only the failures, or clear and invite more.
    chips = chips.filter((c) => !c.valid || !sentEmails.has(c.email));
    sending = false;
  }

  // Reset everything when the modal closes; load the link when it opens.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      void loadLink();
      queueMicrotask(() => emailInputEl?.focus());
    } else if (!open && wasOpen) {
      chips = [];
      draft = "";
      role = "member";
      channelIds = [];
      channelSearch = "";
      results = [];
      linkUrl = "";
      linkCopied = false;
      linkUnavailable = false;
    }
    wasOpen = open;
  });
</script>

<Dialog bind:open onOpenChange={(o) => { if (!o) close(); }}>
  <DialogContent class="sm:max-w-[480px]" showCloseButton={true}>
    <DialogHeader>
      <DialogTitle>Invite Humans</DialogTitle>
    </DialogHeader>

    <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto py-1">
      <!-- To: email chips -->
      <Field label="To" forId="invite-emails" hint="Type an email and press Enter. Paste a list to add many.">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-edge bg-transparent px-2 py-1.5 focus-within:border-edge-light focus-within:ring-[3px] focus-within:ring-edge/30 transition-shadow"
          onclick={() => emailInputEl?.focus()}
        >
          {#each chips as chip (chip.email)}
            <span
              class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[13px] {chip.valid ? 'bg-surface-alt text-content' : 'bg-error/10 text-error'}"
              title={chip.valid ? chip.email : "Invalid email — will be skipped"}
            >
              {chip.email}
              <button
                type="button"
                class="cursor-pointer leading-none opacity-60 hover:opacity-100"
                aria-label="Remove {chip.email}"
                onclick={(e) => { e.stopPropagation(); removeChip(chip.email); }}
              >×</button>
            </span>
          {/each}
          <input
            id="invite-emails"
            bind:this={emailInputEl}
            bind:value={draft}
            type="text"
            inputmode="email"
            autocomplete="off"
            placeholder={chips.length === 0 ? "colleague@example.com" : ""}
            class="min-w-[140px] flex-1 bg-transparent text-sm text-content outline-none placeholder:text-content-muted"
            onkeydown={onEmailKeydown}
            onpaste={onEmailPaste}
            onblur={commitDraft}
          />
        </div>
      </Field>

      <!-- Role -->
      <Field label="Role" hint="Members post · Viewers read-only · Admins manage the workspace.">
        <Select.Root type="single" bind:value={role}>
          <Select.Trigger class={fieldInputClass}>{roleLabel}</Select.Trigger>
          <Select.Content>
            {#each INVITE_ROLES as r (r.value)}
              <Select.Item value={r.value} label={r.label}>{r.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </Field>

      <!-- Add to channels (optional) -->
      <Field label="Add to channels" optional>
        {#if selectedChannels.length > 0}
          <div class="mb-1.5 flex flex-wrap gap-1.5">
            {#each selectedChannels as c (c.id)}
              <span class="inline-flex items-center gap-1 rounded-md bg-surface-alt px-2 py-0.5 text-[13px] text-content">
                #{c.name}
                <button
                  type="button"
                  class="cursor-pointer leading-none opacity-60 hover:opacity-100"
                  aria-label="Remove #{c.name}"
                  onclick={() => removeChannel(c.id)}
                >×</button>
              </span>
            {/each}
          </div>
        {/if}
        <input
          type="text"
          placeholder="Search channels…"
          bind:value={channelSearch}
          class={fieldInputClass}
        />
        {#if channelMatches.length > 0}
          <div class="mt-1.5 max-h-32 overflow-y-auto rounded-md border border-edge-dim">
            {#each channelMatches.slice(0, 30) as c (c.id)}
              <button
                type="button"
                class="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-content hover:bg-hover-gray"
                onclick={() => addChannel(c.id)}
              >
                <span class="text-content-muted">#</span>&nbsp;{c.name}
              </button>
            {/each}
          </div>
        {/if}
      </Field>

      <!-- Send results -->
      {#if results.length > 0}
        <div class="space-y-1 rounded-md border border-edge-dim px-3 py-2">
          {#each results as r (r.email)}
            <p class="flex items-center gap-1.5 text-[13px]">
              {#if r.status === "sent"}
                <span class="text-online">✓</span>
                <span class="text-content-muted">Sent to</span> <span class="text-content">{r.email}</span>
              {:else if r.status === "member"}
                <span class="text-content-muted">○</span>
                <span class="text-content">{r.email}</span> <span class="text-content-muted">already a member</span>
              {:else if r.status === "invalid"}
                <span class="text-error">✕</span>
                <span class="text-content">{r.email}</span> <span class="text-content-muted">invalid</span>
              {:else}
                <span class="text-error">✕</span>
                <span class="text-content">{r.email}</span> <span class="text-error">{r.message ?? "failed"}</span>
              {/if}
            </p>
          {/each}
        </div>
      {/if}

      <!-- OR divider -->
      <div class="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
        <span class="h-px flex-1 bg-edge-dim"></span>
        or
        <span class="h-px flex-1 bg-edge-dim"></span>
      </div>

      <!-- Reusable invite link -->
      <div class="space-y-2">
        <p class="text-[13px] font-medium text-content">Invite link</p>
        <p class="text-xs text-content-muted">Anyone with the link joins as {roleLabel.toLowerCase()}. Links expire 24 hours after they're created — Reset to issue a fresh one.</p>

        {#if linkUnavailable}
          <p class="text-xs text-content-muted">{linkErrorMsg}</p>
        {:else if linkLoading}
          <p class="text-xs text-content-muted">Loading…</p>
        {:else if linkUrl}
          <div class="space-y-2 rounded-md border border-edge-dim px-3 py-2.5">
            <p class="select-all break-all font-mono text-xs text-content">{linkUrl}</p>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={handleCopyLink} disabled={linkBusy}>
                {linkCopied ? "✓ Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onclick={() => syncLink(true)} disabled={linkBusy}>
                {linkBusy ? "Resetting…" : "Reset link"}
              </Button>
            </div>
          </div>
        {:else}
          <Button variant="outline" size="sm" onclick={() => syncLink(false)} disabled={linkBusy}>
            {linkBusy ? "Creating…" : "Create invite link"}
          </Button>
        {/if}
      </div>
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={close}>Cancel</Button>
      <Button onclick={handleSend} disabled={sending || validChips.length === 0}>
        {sending ? "Sending…" : sendLabel}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
