<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    workspaceState,
    cyboState,
    daemonState,
    authState,
    client,
    fetchCybos,
    fetchCybo,
    importCybo,
    updateCybo,
    deleteCybo,
  } from "$lib/state/app.svelte.js";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import CyboReadinessBanner from "$lib/components/agents/components/CyboReadinessBanner.svelte";
  import ApiKeyCredentialField from "$lib/components/agents/components/ApiKeyCredentialField.svelte";
  import { isApiKeyProvider } from "$lib/provider-catalog.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { cn } from "$lib/utils.js";

  const workspaceId = $derived(workspaceState.current?.id);
  const cyboId = $derived(page.params.cyboId ?? "");
  const cybo = $derived(cyboState.list.find((c) => c.id === cyboId));
  const isLocal = $derived(cyboId.startsWith("local:"));

  let name = $state("");
  let description = $state("");
  let role = $state("");
  let provider = $state("");
  let model = $state("");
  let avatar = $state("");
  // An api-key cybo (MiniMax/OpenRouter) needs a per-daemon key — surfaced here so
  // it can be set/updated/removed from the cybo's own settings. Local (disk)
  // cybos are read-only, so no credential entry for them.
  const isApiKeyCybo = $derived(!isLocal && isApiKeyProvider(provider));
  // The daemon that holds the credential: a workspace cybo can run on any
  // accessible daemon, but credentials live per-machine — target the cybo's home
  // daemon if it has one, else the effective daemon.
  const credentialDaemonId = $derived(
    cybo?.daemonId ?? daemonState.effectiveId(authState.user?.id),
  );
  let saving = $state(false);
  let deleting = $state(false);
  let uploading = $state(false);
  let error = $state("");
  let success = $state("");
  // Track the applied id (not a boolean): SvelteKit reuses this component when
  // navigating between cybos, so we must re-init when the id changes.
  let lastCyboId = $state("");
  let fileInput: HTMLInputElement | undefined = $state();

  // Personality (soul) — lazy-loaded because the cybo list omits it.
  let soulText = $state("");
  let soulLoaded = $state(false);
  let soulLoading = $state(false);
  let soulSaving = $state(false);
  let importing = $state(false);

  $effect(() => {
    if (cyboState.list.length === 0 && !cyboState.loading) {
      fetchCybos();
    }
  });

  // (Re)initialize the form + lazy-load the soul whenever the active cybo
  // changes. Keyed on cybo.id so switching cybos resets stale state.
  $effect(() => {
    if (!cybo || cybo.id === lastCyboId) return;
    const id = cybo.id;
    lastCyboId = id;
    name = cybo.name;
    description = cybo.description ?? "";
    role = cybo.role ?? "";
    provider = cybo.provider;
    model = cybo.model ?? "";
    avatar = cybo.avatar ?? "";
    // Reset soul state for the new cybo, then fetch its full soul.
    soulText = "";
    soulLoaded = false;
    soulLoading = true;
    error = "";
    success = "";
    void fetchCybo(id)
      .then((full) => {
        // Guard against a stale fetch resolving after the user switched cybos.
        if (full && lastCyboId === id) {
          soulText = full.soul;
          soulLoaded = true;
        }
      })
      .catch((err) => {
        // The user opened this cybo to view/edit its personality. A silently
        // swallowed fetch left a blank editor with no explanation; surface the
        // failure via the page's existing error banner instead.
        if (lastCyboId === id) {
          error = err instanceof Error ? err.message : "Failed to load personality";
        }
      })
      .finally(() => {
        if (lastCyboId === id) soulLoading = false;
      });
  });

  async function saveSoul(): Promise<void> {
    if (!cybo || isLocal || soulSaving || !soulText.trim()) return;
    soulSaving = true;
    error = "";
    success = "";
    try {
      await updateCybo(cybo.id, { soul: soulText.trim() });
      success = "Personality saved";
      setTimeout(() => { success = ""; }, 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save personality";
    } finally {
      soulSaving = false;
    }
  }

  async function handleImport(): Promise<void> {
    if (!cybo || !isLocal || importing) return;
    importing = true;
    error = "";
    success = "";
    try {
      await importCybo(cybo.slug);
      success = "Imported to workspace";
      setTimeout(() => { success = ""; }, 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to import cybo";
    } finally {
      importing = false;
    }
  }

  const hasChanges = $derived(
    cybo != null && (
      name !== cybo.name ||
      (description || null) !== (cybo.description || null) ||
      (role || null) !== (cybo.role || null) ||
      provider !== cybo.provider ||
      (model || null) !== (cybo.model || null) ||
      (avatar || null) !== (cybo.avatar || null)
    ),
  );

  async function handleSave() {
    if (!cybo || saving || isLocal) return;
    saving = true;
    error = "";
    success = "";
    try {
      await updateCybo(cybo.id, {
        name: name.trim() || undefined,
        description: description.trim() || null,
        role: role.trim() || null,
        provider: provider.trim(),
        model: model.trim() || null,
        avatar: avatar.trim() || null,
        // Keep the auth mode aligned with the provider: api-key providers
        // (MiniMax/OpenRouter) run on a per-daemon key (internal docs);
        // everything else uses the default host-login "cli" mode.
        llmAuthMode: isApiKeyProvider(provider.trim()) ? "api-key" : "cli",
      });
      success = "Saved";
      setTimeout(() => { success = ""; }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to save";
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (!cybo || isLocal) return;
    const confirmed = confirm(`Delete "${cybo.name}"? This cannot be undone.`);
    if (!confirmed) return;
    deleting = true;
    try {
      await deleteCybo(cybo.id);
      goto(`/workspace/${workspaceId}/agent/new`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to delete";
      deleting = false;
    }
  }

  async function handleAvatarUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploading = true;
    error = "";
    try {
      const { publicUrl } = await client.uploadAsset(file, "avatars");
      avatar = publicUrl;
      success = "Avatar uploaded";
      setTimeout(() => { success = ""; }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : "Upload failed";
    } finally {
      uploading = false;
      if (input) input.value = "";
    }
  }

</script>

<div class="flex h-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-6 py-3 shrink-0">
    <button
      type="button"
      aria-label="Back"
      onclick={() => goto(`/workspace/${workspaceId}/agent/new`)}
      class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
    >
      <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <span class="text-sm font-semibold text-content">Cybo Settings</span>
  </header>

  <div class="flex-1 overflow-y-auto">
    {#if !cybo}
      <div class="flex h-full items-center justify-center text-sm text-content-muted">
        {cyboState.loading ? "Loading..." : "Cybo not found"}
      </div>
    {:else}
      <div class="mx-auto max-w-lg px-6 py-8 space-y-6">
        <!-- Avatar preview -->
        <div class="flex items-center gap-4">
          <div class="shrink-0 relative group">
            {#if avatar && !avatar.match(/^\p{Emoji}$/u)}
              <img src={avatar} alt="" class="w-16 h-16 rounded-full object-cover border border-edge" />
            {:else}
              <div class="w-16 h-16 rounded-full bg-surface-alt flex items-center justify-center border border-edge">
                <CyborgIcon size={28} class="text-[var(--agent-accent,#6366f1)]" />
              </div>
            {/if}
            {#if !isLocal}
              <input
                bind:this={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onchange={handleAvatarUpload}
                class="hidden"
              />
              <button
                type="button"
                aria-label="Change avatar"
                onclick={() => fileInput?.click()}
                disabled={uploading}
                class="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-accent-foreground opacity-0 group-hover:opacity-100 transition-opacity"
              >
                {#if uploading}
                  <div class="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin"></div>
                {:else}
                  <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <circle cx="12" cy="13" r="3" />
                  </svg>
                {/if}
              </button>
            {/if}
          </div>
          <div>
            <h2 class="text-lg font-bold text-content">{cybo.name}</h2>
            <span class="text-xs font-mono text-content-dim">{cybo.slug}</span>
            {#if isLocal}
              <span class="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Local</span>
            {/if}
          </div>
        </div>

        <!-- #636: non-blocking "needs daemon" banner when nothing reachable can
             run this cybo's provider yet. -->
        <CyboReadinessBanner readiness={cybo.readiness} {workspaceId} />

        {#if isLocal}
          <div class="rounded-lg bg-warning/10 border border-warning/20 px-4 py-3 text-sm text-warning">
            <p class="font-medium">Local cybo (disk) — read-only here</p>
            <p class="mt-1 text-xs text-content-dim">Lives on this daemon at <code class="font-mono">~/.cybo/agents/{cybo.slug}/</code> (edit <code class="font-mono">cybo.json</code> / <code class="font-mono">soul.md</code> there). Import a copy into this workspace to edit it in-app.</p>
            <button
              type="button"
              onclick={handleImport}
              disabled={importing}
              class="mt-2 rounded-md bg-btn-primary-bg px-3 py-1.5 text-[12px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-50"
            >
              {importing ? "Importing…" : "Import to workspace"}
            </button>
          </div>
        {/if}

        <div class="space-y-4">
          <div>
            <Label for="cybo-edit-name" class="mb-1 text-xs font-medium text-content-muted">Name</Label>
            <Input
              id="cybo-edit-name"
              type="text"
              bind:value={name}
              disabled={isLocal}
              class={cn(isLocal && "opacity-60")}
            />
          </div>

          <div>
            <Label for="cybo-edit-role" class="mb-1 text-xs font-medium text-content-muted">Role</Label>
            <Input
              id="cybo-edit-role"
              type="text"
              bind:value={role}
              disabled={isLocal}
              placeholder="Full-stack engineer, Data analyst..."
              class={cn(isLocal && "opacity-60")}
            />
          </div>

          <div>
            <Label for="cybo-edit-desc" class="mb-1 text-xs font-medium text-content-muted">Description</Label>
            <Input
              id="cybo-edit-desc"
              type="text"
              bind:value={description}
              disabled={isLocal}
              placeholder="Short description"
              class={cn(isLocal && "opacity-60")}
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <Label for="cybo-edit-provider" class="mb-1 text-xs font-medium text-content-muted">Provider</Label>
              <Input
                id="cybo-edit-provider"
                type="text"
                bind:value={provider}
                disabled={isLocal}
                class={cn("font-mono", isLocal && "opacity-60")}
              />
            </div>
            <div>
              <Label for="cybo-edit-model" class="mb-1 text-xs font-medium text-content-muted">Model</Label>
              <Input
                id="cybo-edit-model"
                type="text"
                bind:value={model}
                disabled={isLocal}
                class={cn("font-mono", isLocal && "opacity-60")}
              />
            </div>
          </div>

          {#if isApiKeyCybo}
            <ApiKeyCredentialField providerId={provider} daemonId={credentialDaemonId} />
          {/if}

          <div>
            <Label for="cybo-edit-avatar" class="mb-1 text-xs font-medium text-content-muted">Avatar URL</Label>
            <Input
              id="cybo-edit-avatar"
              type="text"
              bind:value={avatar}
              disabled={isLocal}
              placeholder="https://... or leave empty for Cyborg logo"
              class={cn("font-mono text-xs", isLocal && "opacity-60")}
            />
          </div>

          <div>
            <Label for="cybo-edit-soul" class="mb-1 text-xs font-medium text-content-muted">
              Personality {#if soulLoading}<span class="text-content-dim">(loading…)</span>{/if}
            </Label>
            <Textarea
              id="cybo-edit-soul"
              bind:value={soulText}
              disabled={isLocal}
              rows={10}
              placeholder={isLocal ? "" : "The cybo's soul — who it is and how it behaves (markdown)."}
              class={cn("font-mono text-xs leading-relaxed resize-y", isLocal && "opacity-60")}
            ></Textarea>
            {#if !isLocal}
              <div class="mt-2 flex items-center justify-end">
                <button
                  type="button"
                  onclick={saveSoul}
                  disabled={soulSaving || !soulText.trim()}
                  class="rounded-md bg-btn-primary-bg px-3 py-1.5 text-[12px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-50"
                >
                  {soulSaving ? "Saving…" : "Save personality"}
                </button>
              </div>
            {/if}
          </div>
        </div>

        {#if error}
          <p class="text-xs text-error">{error}</p>
        {/if}
        {#if success}
          <p class="text-xs text-online">{success}</p>
        {/if}

        {#if !isLocal}
          <div class="flex items-center justify-between pt-2">
            <button
              onclick={handleDelete}
              disabled={deleting}
              class="rounded-md px-3 py-1.5 text-sm text-error hover:bg-error/10 transition-colors disabled:opacity-40"
            >{deleting ? "Deleting..." : "Delete Cybo"}</button>

            <button
              onclick={handleSave}
              disabled={saving || !hasChanges}
              class="rounded-md bg-btn-primary-bg px-4 py-1.5 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >{saving ? "Saving..." : "Save changes"}</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
