<script lang="ts">
  // Write-only API-key entry for an openai-compatible (raw-API) cybo provider —
  // MiniMax / OpenRouter (internal docs). The key is NEVER read
  // back: we only learn set/not-set from `cyborg:list_provider_auth` (metadata),
  // and write it with `cyborg:set_cybo_credential`. Both RPCs are daemon-forwarded
  // and require an explicit `daemonId` (the credential lives on that machine).
  //
  // States:
  //   • no key set  → "API key required" + an entry field (mirrors provider-remedy
  //                    "not_configured": a cybo on this provider can't run yet).
  //   • key set     → "Key set ✓" + Update / Remove.
  // Native (claude/codex) and PI providers never render this — it's additive.
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    setCyboCredential,
    removeCyboCredential,
    listProviderAuth,
  } from "$lib/state/app.svelte.js";
  import { apiKeyProviderById } from "$lib/provider-catalog.js";

  let {
    providerId,
    daemonId,
    onChange,
  }: {
    /** The openai-compatible provider id (e.g. "openrouter", "minimax"). */
    providerId: string;
    /**
     * The daemon that will hold the credential. Null when no runnable daemon is
     * resolvable yet — the field then explains why it can't save.
     */
    daemonId: string | null | undefined;
    /** Notified after a set/remove so parents can refresh readiness UI. */
    onChange?: (isSet: boolean) => void;
  } = $props();

  const provider = $derived(apiKeyProviderById(providerId));

  // set/not-set is derived from list_provider_auth metadata — never the key.
  let isSet = $state(false);
  let loading = $state(true);
  let editing = $state(false);
  let keyInput = $state("");
  let saving = $state(false);
  let removing = $state(false);
  let error = $state("");

  // Track what we last loaded so we re-probe when provider/daemon changes.
  let loadedFor = $state("");

  $effect(() => {
    const key = `${providerId}::${daemonId ?? ""}`;
    if (key === loadedFor) return;
    loadedFor = key;
    isSet = false;
    editing = false;
    keyInput = "";
    error = "";
    if (!daemonId) {
      loading = false;
      return;
    }
    loading = true;
    void refreshAuth(daemonId);
  });

  async function refreshAuth(targetDaemon: string): Promise<void> {
    const token = `${providerId}::${targetDaemon}`;
    try {
      const creds = await listProviderAuth(targetDaemon);
      // Guard a stale resolve after the user switched provider/daemon.
      if (token !== loadedFor) return;
      isSet = creds.some((c) => c.providerId === providerId && c.type === "api");
    } catch (e) {
      if (token !== loadedFor) return;
      error = e instanceof Error ? e.message : "Couldn't check the key status";
    } finally {
      if (token === loadedFor) loading = false;
    }
  }

  async function save(): Promise<void> {
    const key = keyInput.trim();
    if (!daemonId || saving || !key) return;
    saving = true;
    error = "";
    try {
      await setCyboCredential(daemonId, providerId, { type: "api", key });
      isSet = true;
      editing = false;
      keyInput = "";
      onChange?.(true);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save the API key";
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    if (!daemonId || removing) return;
    removing = true;
    error = "";
    try {
      await removeCyboCredential(daemonId, providerId);
      isSet = false;
      editing = false;
      keyInput = "";
      onChange?.(false);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove the API key";
    } finally {
      removing = false;
    }
  }
</script>

{#if provider}
  <div class="mt-4 rounded-[10px] border border-edge bg-surface-alt px-4 py-3.5">
    <div class="flex items-center justify-between gap-2">
      <Label class="text-[13px] font-semibold text-content">API key</Label>
      {#if loading}
        <span class="text-[12px] text-content-muted">Checking…</span>
      {:else if isSet}
        <Badge variant="attentionDone">Key set ✓</Badge>
      {:else}
        <Badge variant="permission">API key required</Badge>
      {/if}
    </div>

    <p class="mt-1 text-[12.5px] text-content-dim">
      {provider.label} runs on an API key stored on the daemon — it's write-only and never shown
      back.
      {#if provider.consoleUrl}
        Get one at
        <a
          href={provider.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:no-underline">{provider.consoleUrl}</a
        >.
      {/if}
    </p>

    {#if !daemonId}
      <p class="mt-2 text-[12px] text-warning">
        Connect a daemon to store the key — the credential lives on the machine that runs the cybo.
      </p>
    {:else if isSet && !editing}
      <div class="mt-2.5 flex items-center gap-2">
        <Button variant="secondary" size="sm" onclick={() => (editing = true)} disabled={removing}>
          Update key
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="text-error hover:text-error"
          onclick={remove}
          disabled={removing}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    {:else}
      <div class="mt-2.5 flex flex-col gap-2">
        <Input
          type="password"
          autocomplete="off"
          bind:value={keyInput}
          placeholder={`Paste your ${provider.label} API key`}
          class="font-mono text-[13px]"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div class="flex items-center gap-2">
          <Button size="sm" onclick={save} disabled={saving || !keyInput.trim()}>
            {saving ? "Saving…" : "Save key"}
          </Button>
          {#if isSet}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => {
                editing = false;
                keyInput = "";
                error = "";
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          {/if}
        </div>
      </div>
    {/if}

    {#if error}
      <p class="mt-2 text-[12px] text-error">{error}</p>
    {/if}
  </div>
{/if}
