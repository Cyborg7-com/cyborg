<script lang="ts">
  // Settings tab — the SINGLE channel editor (replaces the old stacked
  // ChannelEditForm dialog). Inline fields + a danger zone with a CONSISTENT
  // confirm step for both Archive and Delete. Mutations are delegated to the
  // parent dialog (single source of truth for channel data + open state).
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import type { Channel } from "$lib/core/types.js";

  let {
    channel,
    canAdmin = false,
    autofocusName = false,
    onsave,
    onarchive,
    ondelete,
    onleave,
  }: {
    channel: Channel;
    canAdmin?: boolean;
    autofocusName?: boolean;
    onsave: (updates: {
      name: string;
      description: string | null;
      instructions: string | null;
      isPrivate: boolean;
    }) => Promise<void>;
    onarchive: (archived: boolean) => Promise<void>;
    ondelete: () => Promise<void>;
    onleave: () => Promise<void>;
  } = $props();

  // Re-seed when opened for a DIFFERENT channel (guard on id — the prop is a
  // $derived whose reference changes on every mutation).
  let editName = $state("");
  let editDesc = $state("");
  let editInstr = $state("");
  let editPrivate = $state(false);
  let seededId: string | undefined;
  $effect(() => {
    if (channel.id !== seededId) {
      seededId = channel.id;
      editName = channel.name;
      editDesc = channel.description ?? "";
      editInstr = channel.instructions ?? "";
      editPrivate = channel.isPrivate;
    }
  });

  let saving = $state(false);
  let error = $state<string | null>(null);
  type Confirm = "none" | "archive" | "delete";
  let confirm = $state<Confirm>("none");
  let busy = $state(false);

  let nameEl = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (autofocusName && nameEl) nameEl.focus();
  });

  const dirty = $derived(
    editName !== channel.name ||
      editDesc !== (channel.description ?? "") ||
      editInstr !== (channel.instructions ?? "") ||
      editPrivate !== channel.isPrivate,
  );

  async function handleSave() {
    // The name IS the slug (lowercase, no spaces) — surfaced via the hint below.
    const slug = editName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) return;
    saving = true;
    error = null;
    try {
      await onsave({
        name: slug,
        description: editDesc.trim() || null,
        instructions: editInstr.trim() || null,
        isPrivate: editPrivate,
      });
    } catch (err) {
      error =
        err instanceof Error ? err.message : "Failed to update channel (the name may be taken).";
    } finally {
      saving = false;
    }
  }

  async function run(fn: () => Promise<void>) {
    busy = true;
    error = null;
    try {
      await fn();
    } catch (err) {
      // Surface danger-zone failures (leave/archive/delete) in the banner instead
      // of an unhandled rejection. The confirm stays open so the user can retry.
      error = err instanceof Error ? err.message : "Action failed. Please try again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-5">
  {#if error}
    <div class="rounded-md bg-error/10 px-3 py-2 text-[13px] text-error">{error}</div>
  {/if}

  <!-- Editable channel fields are admin-only. A non-admin member sees just the
       danger-zone "Leave channel" action below — no name/description/privacy
       controls (not even read-only) and no Save. -->
  {#if canAdmin}
    <div class="space-y-1.5">
      <Label for="ch-name" class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
        Name
      </Label>
      <div class="flex items-center gap-1.5">
        <span class="text-content-muted text-sm">#</span>
        <Input
          id="ch-name"
          bind:ref={nameEl}
          bind:value={editName}
          maxlength={40}
          oninput={() => (editName = editName.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
        />
      </div>
      <p class="text-xs text-content-dim">Lowercase, no spaces — this is the channel's handle.</p>
    </div>

    <div class="space-y-1.5">
      <Label for="ch-desc" class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
        Description
      </Label>
      <Textarea
        id="ch-desc"
        bind:value={editDesc}
        rows={2}
        placeholder="What's this channel about?"
      />
    </div>

    <div class="space-y-1.5">
      <Label
        for="ch-instr"
        class="text-[11px] font-semibold uppercase tracking-wider text-content-muted"
      >
        Agent instructions
      </Label>
      <Textarea
        id="ch-instr"
        bind:value={editInstr}
        rows={2}
        placeholder="Guidelines for agents acting in this channel"
      />
    </div>

    <div class="flex items-center justify-between">
      <div>
        <div class="text-sm text-content">Private channel</div>
        <div class="text-xs text-content-dim">Only invited members can see and post.</div>
      </div>
      <Switch bind:checked={editPrivate} aria-label="Private channel" />
    </div>

    <div class="flex justify-end">
      <Button size="sm" onclick={handleSave} disabled={saving || !dirty || !editName.trim()}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  {/if}

  <!-- ── Danger zone ─────────────────────────────────────────────── -->
  <div class="space-y-2 border-t border-edge pt-4">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Danger zone</div>

    <div class="flex items-center justify-between rounded-lg border border-edge px-3 py-2.5">
      <div>
        <div class="text-sm font-medium text-content">Leave channel</div>
        <div class="text-xs text-content-dim">You'll stop receiving messages from this channel.</div>
      </div>
      <Button variant="ghost" size="sm" class="text-content-muted" disabled={busy} onclick={() => run(onleave)}>
        Leave
      </Button>
    </div>

    {#if canAdmin}
      {#if confirm === "archive"}
        <div class="rounded-lg border border-edge px-3 py-2.5">
          <p class="text-sm text-content-dim">
            {channel.isArchived
              ? "Unarchive this channel? It returns to the active list."
              : "Archive this channel? History is preserved and it can be unarchived later — the safe alternative to deleting."}
          </p>
          <div class="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onclick={() => (confirm = "none")}>Cancel</Button>
            <Button size="sm" disabled={busy} onclick={() => run(() => onarchive(!channel.isArchived))}>
              {channel.isArchived ? "Unarchive" : "Archive"}
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center justify-between rounded-lg border border-edge px-3 py-2.5">
          <div>
            <div class="text-sm font-medium text-content">
              {channel.isArchived ? "Unarchive channel" : "Archive channel"}
            </div>
            <div class="text-xs text-content-dim">Hide from the active list but keep all history (recommended).</div>
          </div>
          <Button variant="outline" size="sm" onclick={() => (confirm = "archive")}>
            {channel.isArchived ? "Unarchive" : "Archive"}
          </Button>
        </div>
      {/if}

      {#if confirm === "delete"}
        <div class="rounded-lg border border-error/40 px-3 py-2.5">
          <p class="text-sm text-content-dim">
            Delete <strong>#{channel.name}</strong>? This can't be undone. Consider
            <strong>archiving</strong> instead — it keeps the channel reachable in history.
          </p>
          <div class="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onclick={() => (confirm = "none")}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={busy} onclick={() => run(ondelete)}>
              Delete channel
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center justify-between rounded-lg border border-error/40 px-3 py-2.5">
          <div>
            <div class="text-sm font-medium text-error">Delete channel</div>
            <div class="text-xs text-content-dim">Permanently remove this channel.</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="text-error hover:text-error"
            onclick={() => (confirm = "delete")}
          >
            Delete…
          </Button>
        </div>
      {/if}
    {/if}
  </div>
</div>
