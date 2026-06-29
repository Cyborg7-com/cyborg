<script lang="ts">
  import { goto } from "$app/navigation";
  import { workspaceState, updateWorkspace, deleteWorkspace } from "$lib/state/app.svelte.js";
  import { client } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import type { ChannelCreatePolicy } from "$lib/core/types.js";

  const workspace = $derived(workspaceState.current);
  const myRole = $derived(workspace?.role ?? "viewer");
  const canEdit = $derived(myRole === "owner" || myRole === "admin");
  const isOwner = $derived(myRole === "owner");

  // Seed from the workspace, re-seeding on workspace switch (guarded by id)
  // instead of capturing it once (state_referenced_locally, #178).
  let nameValue = $state("");
  let seededWsId: string | undefined;
  $effect(() => {
    if (workspace?.id !== seededWsId) {
      seededWsId = workspace?.id;
      nameValue = workspace?.name ?? "";
    }
  });
  let saving = $state(false);
  let saveSuccess = $state(false);
  let saveError = $state("");
  let uploading = $state(false);
  let uploadError = $state("");
  let copied = $state(false);

  $effect(() => {
    if (workspace) nameValue = workspace.name;
  });

  const nameChanged = $derived(nameValue.trim() !== "" && nameValue.trim() !== workspace?.name);

  async function handleSaveName() {
    if (!nameChanged || saving) return;
    saving = true;
    saveError = "";
    saveSuccess = false;
    try {
      await updateWorkspace({ name: nameValue.trim() });
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 2000);
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to save";
    } finally {
      saving = false;
    }
  }

  async function handleAvatarUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      uploadError = "File must be under 2 MB";
      return;
    }

    uploading = true;
    uploadError = "";
    try {
      const { publicUrl } = await client.uploadAsset(file, "workspaces");
      await updateWorkspace({ avatarUrl: publicUrl });
    } catch (err) {
      uploadError = err instanceof Error ? err.message : "Upload failed";
    } finally {
      uploading = false;
      input.value = "";
    }
  }

  async function handleRemoveAvatar() {
    saving = true;
    try {
      await updateWorkspace({ avatarUrl: null });
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to remove avatar";
    } finally {
      saving = false;
    }
  }

  async function copyId() {
    if (!workspace) return;
    await navigator.clipboard.writeText(workspace.id);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  // ─── Agent workspace context ───────────────────────────────────
  // Init empty; the effect below seeds + re-seeds it from the workspace (don't
  // read the reactive prop in the initializer — state_referenced_locally, #178).
  let contextValue = $state("");
  let contextSaving = $state(false);
  let contextSuccess = $state(false);

  $effect(() => {
    if (workspace) contextValue = workspace.settings?.agentWorkspaceContext ?? "";
  });

  const contextChanged = $derived(
    contextValue !== (workspace?.settings?.agentWorkspaceContext ?? ""),
  );

  async function handleSaveContext() {
    if (!workspace || !contextChanged || contextSaving) return;
    contextSaving = true;
    contextSuccess = false;
    try {
      await updateWorkspace({
        settings: { ...workspace.settings, agentWorkspaceContext: contextValue },
      });
      contextSuccess = true;
      setTimeout(() => { contextSuccess = false; }, 2000);
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to save";
    } finally {
      contextSaving = false;
    }
  }

  // ─── Channel creation policies ─────────────────────────────────
  const POLICY_OPTIONS: { value: ChannelCreatePolicy; label: string }[] = [
    { value: "everyone", label: "Everyone" },
    { value: "admins", label: "Admins only" },
    { value: "owner", label: "Owner only" },
  ];

  async function handlePolicyChange(
    key: "publicChannelCreatePolicy" | "privateChannelCreatePolicy",
    value: ChannelCreatePolicy,
  ) {
    if (!workspace) return;
    try {
      await updateWorkspace({ settings: { ...workspace.settings, [key]: value } });
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Failed to save";
    }
  }

  // ─── Danger zone ───────────────────────────────────────────────
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let deleteError = $state("");

  async function handleDelete() {
    if (!workspace || deleting) return;
    deleting = true;
    deleteError = "";
    try {
      await deleteWorkspace(workspace.id);
      const next = workspaceState.current;
      goto(next ? `/workspace/${next.id}` : "/");
    } catch (e) {
      deleteError = e instanceof Error ? e.message : "Failed to delete workspace";
      deleting = false;
    }
  }
</script>

{#if viewportState.isMobile}
  <!-- ── Mobile: iOS grouped inset cards ── -->
  <div class="px-4 pb-8 pt-3 space-y-6">

    {#if workspace}
      <!-- Avatar -->
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Avatar</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
          <div class="flex items-center gap-4">
            {#if workspace.avatarUrl}
              <img
                src={workspace.avatarUrl}
                alt={workspace.name}
                class="h-[60px] w-[60px] rounded-[14px] object-cover"
              />
            {:else}
              <div class="flex h-[60px] w-[60px] items-center justify-center rounded-[14px] bg-accent/20 text-[22px] font-bold text-accent">
                {workspace.name.charAt(0).toUpperCase()}
              </div>
            {/if}

            {#if canEdit}
              <div class="flex flex-col gap-2">
                <label
                  class={cn(
                    "pressable inline-flex h-[40px] cursor-pointer items-center gap-2 rounded-[10px] border border-edge px-3 text-[15px] font-medium text-content focus-ring",
                    uploading && "opacity-50 pointer-events-none",
                  )}
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  {uploading ? "Uploading…" : "Upload image"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    class="hidden"
                    onchange={handleAvatarUpload}
                    disabled={uploading}
                  />
                </label>
                {#if workspace.avatarUrl}
                  <button
                    type="button"
                    onclick={handleRemoveAvatar}
                    class="pressable text-[14px] text-error text-left focus-ring"
                  >
                    Remove avatar
                  </button>
                {/if}
              </div>
            {/if}
          </div>
          {#if uploadError}
            <p class="mt-2 text-[13px] text-error">{uploadError}</p>
          {/if}
        </div>
      </div>

      <!-- Name -->
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Name</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px] space-y-3">
          <input
            type="text"
            bind:value={nameValue}
            disabled={!canEdit}
            placeholder="Workspace name"
            class="h-[44px] w-full rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content placeholder:text-content-muted outline-none focus:border-accent disabled:opacity-50"
            onkeydown={(e) => { if (e.key === "Enter") handleSaveName(); }}
          />
          {#if canEdit}
            <button
              type="button"
              onclick={handleSaveName}
              disabled={!nameChanged || saving}
              class="pressable h-[44px] w-full rounded-[10px] bg-btn-primary-bg text-[16px] font-medium text-btn-primary-text disabled:opacity-40 focus-ring"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          {/if}
          {#if saveSuccess}
            <p class="text-[13px] text-online">Name updated</p>
          {/if}
          {#if saveError}
            <p class="text-[13px] text-error">{saveError}</p>
          {/if}
          <p class="text-[13px] text-content-muted">
            Display name shown in the sidebar and workspace list.
          </p>
        </div>
      </div>

      <!-- Workspace ID -->
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Workspace ID</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          <div class="flex min-h-[44px] items-center gap-3 px-[16px] py-[10px]">
            <code class="min-w-0 flex-1 select-all truncate font-mono text-[13px] text-content-muted">
              {workspace.id}
            </code>
            <button
              type="button"
              onclick={copyId}
              class="pressable shrink-0 rounded-[8px] border border-edge px-3 py-1.5 text-[14px] font-medium text-content-muted focus-ring"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
        <p class="mt-2 px-[4px] text-[13px] text-content-muted">
          Unique identifier. Share for integrations and API access.
        </p>
      </div>

      {#if canEdit}
        <!-- Agent Workspace Context -->
        <div>
          <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Agent Workspace Context</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px] space-y-3">
            <textarea
              bind:value={contextValue}
              rows="4"
              placeholder="Context injected into every message agents receive in this workspace."
              class="w-full resize-y rounded-[10px] border border-edge bg-surface px-3 py-2 text-[16px] text-content placeholder:text-content-muted outline-none focus:border-accent"
            ></textarea>
            <div class="flex items-center gap-3">
              <button
                type="button"
                onclick={handleSaveContext}
                disabled={!contextChanged || contextSaving}
                class="pressable h-[44px] flex-1 rounded-[10px] bg-btn-primary-bg text-[16px] font-medium text-btn-primary-text disabled:opacity-40 focus-ring"
              >
                {contextSaving ? "Saving…" : "Save"}
              </button>
              {#if contextSuccess}
                <span class="text-[13px] text-online">Context updated</span>
              {/if}
            </div>
            <p class="text-[13px] text-content-muted">
              Sets the cultural context for your workspace. Leave blank for the default.
            </p>
          </div>
        </div>

        <!-- Channel Creation Policies -->
        <div>
          <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Channel Creation</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            <div class="flex min-h-[48px] items-center justify-between gap-3 px-[16px] py-[10px]">
              <span class="text-[16px] text-content">Public channels</span>
              <select
                value={workspace.settings?.publicChannelCreatePolicy ?? "everyone"}
                onchange={(e) => handlePolicyChange("publicChannelCreatePolicy", e.currentTarget.value as ChannelCreatePolicy)}
                class="h-[36px] rounded-[8px] border border-edge bg-surface px-2 text-[14px] text-content outline-none"
                aria-label="Who can create public channels"
              >
                {#each POLICY_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
            <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
            <div class="flex min-h-[48px] items-center justify-between gap-3 px-[16px] py-[10px]">
              <span class="text-[16px] text-content">Private channels</span>
              <select
                value={workspace.settings?.privateChannelCreatePolicy ?? "everyone"}
                onchange={(e) => handlePolicyChange("privateChannelCreatePolicy", e.currentTarget.value as ChannelCreatePolicy)}
                class="h-[36px] rounded-[8px] border border-edge bg-surface px-2 text-[14px] text-content outline-none"
                aria-label="Who can create private channels"
              >
                {#each POLICY_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>
      {/if}

      {#if isOwner}
        <!-- Danger zone -->
        <div>
          <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-error">Danger Zone</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            <button
              type="button"
              onclick={() => { confirmDelete = !confirmDelete; }}
              class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring"
            >
              <span class="text-[16px] text-error">Delete this workspace</span>
            </button>
          </div>

          {#if confirmDelete}
            <div class="mt-3 overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px] space-y-3">
              <p class="text-[14px] text-content-muted">
                Permanently removes the workspace, its channels, messages, and members. This cannot be undone.
              </p>
              <button
                type="button"
                onclick={handleDelete}
                disabled={deleting}
                class="pressable h-[44px] w-full rounded-[10px] bg-error text-[16px] font-medium text-accent-foreground disabled:opacity-40 focus-ring"
              >
                {deleting ? "Deleting…" : "Yes, delete permanently"}
              </button>
              <button
                type="button"
                onclick={() => { confirmDelete = false; }}
                disabled={deleting}
                class="pressable h-[44px] w-full rounded-[10px] border border-edge text-[16px] text-content-muted disabled:opacity-40 focus-ring"
              >
                Cancel
              </button>
              {#if deleteError}
                <p class="text-[13px] text-error">{deleteError}</p>
              {/if}
            </div>
          {/if}
          <p class="mt-2 px-[4px] text-[13px] text-content-muted">
            Permanently removes the workspace, its channels, messages, and members.
          </p>
        </div>
      {/if}
    {/if}

  </div>
{:else}
  <!-- ── Desktop: original layout (byte-equal) ── -->
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
    <header>
      <h1 class="text-lg font-semibold text-content">Workspace</h1>
      <p class="mt-1 text-xs text-content-muted">Identity and profile for this workspace</p>
    </header>

    {#if workspace}
      <!-- Avatar -->
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Avatar
        </span>
        <div class="flex items-center gap-4">
          {#if workspace.avatarUrl}
            <img
              src={workspace.avatarUrl}
              alt={workspace.name}
              class="h-16 w-16 rounded-xl object-cover border border-edge"
            />
          {:else}
            <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-accent/20 text-xl font-bold text-accent border border-edge">
              {workspace.name.charAt(0).toUpperCase()}
            </div>
          {/if}

          {#if canEdit}
            <div class="flex flex-col gap-2">
              <label
                class={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-alt transition-colors",
                  uploading && "opacity-50 pointer-events-none",
                )}
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                {uploading ? "Uploading..." : "Upload image"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  class="hidden"
                  onchange={handleAvatarUpload}
                  disabled={uploading}
                />
              </label>
              {#if workspace.avatarUrl}
                <button
                  onclick={handleRemoveAvatar}
                  class="text-xs text-content-muted hover:text-error transition-colors text-left"
                >
                  Remove avatar
                </button>
              {/if}
            </div>
          {/if}
        </div>
        {#if uploadError}
          <p class="text-xs text-error">{uploadError}</p>
        {/if}
      </section>

      <!-- Name -->
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Name
        </span>
        <div class="space-y-2">
          <div class="flex gap-3">
            <input
              type="text"
              bind:value={nameValue}
              disabled={!canEdit}
              placeholder="Workspace name"
              class="flex-1 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
              onkeydown={(e) => { if (e.key === "Enter") handleSaveName(); }}
            />
            {#if canEdit}
              <button
                onclick={handleSaveName}
                disabled={!nameChanged || saving}
                class="rounded-md bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "..." : "Save"}
              </button>
            {/if}
          </div>
          {#if saveSuccess}
            <p class="text-xs text-green-400">Name updated</p>
          {/if}
          {#if saveError}
            <p class="text-xs text-error">{saveError}</p>
          {/if}
          <p class="text-xs text-content-muted">
            This is the display name shown in the sidebar and workspace list.
          </p>
        </div>
      </section>

      <!-- Workspace ID -->
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Workspace ID
        </span>
        <div class="flex items-center gap-3 rounded-lg border border-edge px-4 py-3">
          <code class="flex-1 text-sm text-content-dim font-mono select-all truncate">
            {workspace.id}
          </code>
          <button
            onclick={copyId}
            class="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs font-medium text-content-muted hover:text-content hover:bg-surface-alt transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p class="text-xs text-content-muted">
          Unique identifier for this workspace. Share this ID for integrations and API access.
        </p>
      </section>

      {#if canEdit}
        <!-- Agent workspace context -->
        <section class="space-y-3">
          <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
            Agent Workspace Context
          </span>
          <textarea
            bind:value={contextValue}
            rows="4"
            placeholder="Context injected into every message agents receive in this workspace."
            class="w-full resize-y rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted outline-none focus:border-accent"
          ></textarea>
          <div class="flex items-center gap-3">
            <button
              onclick={handleSaveContext}
              disabled={!contextChanged || contextSaving}
              class="rounded-md bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {contextSaving ? "..." : "Save"}
            </button>
            {#if contextSuccess}
              <span class="text-xs text-green-400">Context updated</span>
            {/if}
          </div>
          <p class="text-xs text-content-muted">
            Sets the cultural context for your workspace. Leave blank to use the default.
          </p>
        </section>

        <!-- Channel creation policies -->
        <section class="space-y-3">
          <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
            Channel Creation
          </span>
          <div class="space-y-3">
            <label class="flex items-center justify-between gap-3">
              <span class="text-sm text-content">Who can create public channels?</span>
              <select
                value={workspace.settings?.publicChannelCreatePolicy ?? "everyone"}
                onchange={(e) => handlePolicyChange("publicChannelCreatePolicy", e.currentTarget.value as ChannelCreatePolicy)}
                class="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm text-content outline-none focus:border-accent"
              >
                {#each POLICY_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </label>
            <label class="flex items-center justify-between gap-3">
              <span class="text-sm text-content">Who can create private channels?</span>
              <select
                value={workspace.settings?.privateChannelCreatePolicy ?? "everyone"}
                onchange={(e) => handlePolicyChange("privateChannelCreatePolicy", e.currentTarget.value as ChannelCreatePolicy)}
                class="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm text-content outline-none focus:border-accent"
              >
                {#each POLICY_OPTIONS as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </label>
          </div>
        </section>
      {/if}

      {#if isOwner}
        <!-- Danger zone -->
        <section class="space-y-3">
          <span class="block text-xs font-medium text-error uppercase tracking-wider">
            Danger Zone
          </span>
          <div class="rounded-lg border border-error/40 px-4 py-4 space-y-3">
            <div>
              <p class="text-sm font-medium text-content">Delete this workspace</p>
              <p class="text-xs text-content-muted">
                Permanently removes the workspace, its channels, messages, and members. This cannot be
                undone.
              </p>
            </div>
            {#if confirmDelete}
              <div class="flex items-center gap-3">
                <button
                  onclick={handleDelete}
                  disabled={deleting}
                  class="rounded-md bg-error px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {deleting ? "Deleting..." : "Yes, delete permanently"}
                </button>
                <button
                  onclick={() => { confirmDelete = false; }}
                  disabled={deleting}
                  class="text-xs text-content-muted hover:text-content transition-colors"
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button
                onclick={() => { confirmDelete = true; }}
                class="rounded-md border border-error/60 px-4 py-2 text-sm font-medium text-error hover:bg-error/10 transition-colors"
              >
                Delete workspace
              </button>
            {/if}
            {#if deleteError}
              <p class="text-xs text-error">{deleteError}</p>
            {/if}
          </div>
        </section>
      {/if}
    {/if}
  </div>
{/if}
