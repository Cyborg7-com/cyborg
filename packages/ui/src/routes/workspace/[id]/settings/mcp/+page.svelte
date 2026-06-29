<script lang="ts">
  import { client, workspaceState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import type { McpListResponse, McpToken } from "$lib/core/client.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
  } from "$lib/components/ui/dialog/index.js";

  const workspaceId = $derived(workspaceState.current?.id ?? "");
  const myRole = $derived(workspaceState.current?.role ?? "viewer");
  // Tokens are per-user: every member manages their own. Only the workspace
  // master switch stays owner/admin.
  const canManageWorkspace = $derived(myRole === "owner" || myRole === "admin");

  let data = $state<McpListResponse | null>(null);
  let loading = $state(false);
  let msg = $state("");

  // Create-token dialog state.
  let dialogOpen = $state(false);
  let newName = $state("");
  let newIdentityKey = $state(""); // "cybo:<id>" | "user:<id>"
  let scopeRead = $state(true);
  let scopeWrite = $state(false);
  let expiresInDays = $state("");
  let creating = $state(false);
  // The raw token, shown ONCE after creation.
  let createdToken = $state("");

  let copied = $state("");

  function flash(text: string, ms = 2500) {
    msg = text;
    setTimeout(() => {
      msg = "";
    }, ms);
  }

  async function load() {
    if (!workspaceId) return;
    loading = true;
    try {
      data = await client.mcpList(workspaceId);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to load MCP settings");
    } finally {
      loading = false;
    }
  }

  // Reload whenever the active workspace changes.
  $effect(() => {
    if (workspaceId) void load();
  });

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => {
        copied = "";
      }, 1500);
    } catch {
      flash("Copy failed");
    }
  }

  async function setEnabled(next: boolean) {
    if (!data) return;
    // Optimistic: the Switch has already flipped visually, so mirror it in state
    // immediately and revert on failure — otherwise an API error leaves the
    // control showing a value the server never accepted.
    const prev = data.enabled;
    data.enabled = next;
    try {
      data.enabled = await client.mcpSetEnabled(workspaceId, next);
    } catch (e) {
      data.enabled = prev;
      flash(e instanceof Error ? e.message : "Failed to update");
    }
  }

  function openDialog() {
    newName = "";
    newIdentityKey = data?.identities.cybos[0]
      ? `cybo:${data.identities.cybos[0].id}`
      : data?.identities.self
        ? `user:${data.identities.self.id}`
        : "";
    scopeRead = true;
    scopeWrite = false;
    expiresInDays = "";
    createdToken = "";
    dialogOpen = true;
  }

  async function createToken() {
    if (!newName.trim() || !newIdentityKey) {
      flash("Name and identity are required");
      return;
    }
    const scopes: string[] = [];
    if (scopeRead) scopes.push("read");
    if (scopeWrite) scopes.push("write");
    if (scopes.length === 0) {
      flash("Pick at least one scope");
      return;
    }
    const [identityType, identityId] = newIdentityKey.split(":") as ["cybo" | "user", string];
    const days = Number.parseInt(expiresInDays, 10);
    creating = true;
    try {
      const res = await client.mcpCreateToken(workspaceId, {
        name: newName.trim(),
        identityType,
        identityId,
        scopes,
        ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
      });
      createdToken = res.token;
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      creating = false;
    }
  }

  async function toggleToken(t: McpToken) {
    try {
      await client.mcpToggleToken(workspaceId, t.id, !t.enabled);
      t.enabled = !t.enabled;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to update token");
    }
  }

  async function revokeToken(t: McpToken) {
    if (!confirm(`Revoke token "${t.name}"? This cannot be undone.`)) return;
    try {
      await client.mcpRevokeToken(workspaceId, t.id);
      if (data) data.tokens = data.tokens.filter((x) => x.id !== t.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to revoke token");
    }
  }

  function identityLabel(t: McpToken): string {
    if (t.identityType === "cybo") {
      return data?.identities.cybos.find((c) => c.id === t.identityId)?.name ?? `cybo ${t.identityId}`;
    }
    return data?.identities.self?.id === t.identityId
      ? (data?.identities.self?.name ?? "you")
      : `user ${t.identityId}`;
  }

  function fmtDate(ms: number | null): string {
    if (!ms) return "never";
    return new Date(ms).toLocaleDateString();
  }

  // Ready-to-paste MCP client config for the freshly-minted token. Built only
  // while the raw token is on screen — it is never reconstructable later.
  const connectionJson = $derived(
    createdToken
      ? JSON.stringify(
          {
            mcpServers: {
              cyborg7: {
                type: "http",
                url: data?.connectionUrl ?? "<relay-url>/mcp",
                headers: { Authorization: `Bearer ${createdToken}` },
              },
            },
          },
          null,
          2,
        )
      : "",
  );

  // Same client config with a <token> placeholder for the main page: we only
  // store token hashes, so the real value can't be re-shown after creation.
  const placeholderJson = $derived(
    JSON.stringify(
      {
        mcpServers: {
          cyborg7: {
            type: "http",
            url: data?.connectionUrl ?? "<relay-url>/mcp",
            headers: { Authorization: "Bearer <token>" },
          },
        },
      },
      null,
      2,
    ),
  );

  const TOOLS: Array<{ name: string; scope: string; desc: string }> = [
    { name: "whoami", scope: "—", desc: "Report the token's identity, workspace and scopes." },
    { name: "list_workspaces", scope: "read", desc: "The workspace this token can access." },
    { name: "list_channels", scope: "read", desc: "Channels visible to the identity." },
    { name: "read_channel", scope: "read", desc: "Recent messages in a channel." },
    { name: "post_message", scope: "write", desc: "Post a message to a channel." },
    { name: "reply_in_thread", scope: "write", desc: "Reply to a message in its thread." },
  ];

  // ─── Inbound webhooks ───────────────────────────────────────────
  // The webhook endpoint shares the relay base with the MCP URL (…/mcp) and
  // authenticates with a WRITE-scoped token from above. Tokens are stored as
  // hashes, so the examples use a <write-token> placeholder.
  const webhookBase = $derived((data?.connectionUrl ?? "<relay-url>/mcp").replace(/\/mcp$/, ""));
  let webhookChannelId = $state("");
  // Seed the picker to the first channel once channels load, so the bound value
  // matches what the <select> shows (an empty bind leaves them out of sync).
  $effect(() => {
    if (workspaceState.channels.length > 0 && !webhookChannelId) {
      webhookChannelId = workspaceState.channels[0].id;
    }
  });
  const webhookChannel = $derived(
    workspaceState.channels.find((ch) => ch.id === webhookChannelId) ?? workspaceState.channels[0],
  );
  const webhookUrl = $derived(`${webhookBase}/api/webhooks/${webhookChannel?.id ?? "<channel-id>"}`);
  const webhookCurl = $derived(
    `curl -X POST "${webhookUrl}?token=<write-token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"hello from CI","username":"deploybot"}'`,
  );
</script>

<div class={viewportState.isMobile ? "" : "flex-1 overflow-y-auto p-6"}>
  <div class={viewportState.isMobile ? "px-4 pb-8 pt-3 space-y-6" : "mx-auto max-w-3xl space-y-6"}>
    {#if !viewportState.isMobile}
      <div>
        <h1 class="text-lg font-bold text-content">MCP</h1>
        <p class="mt-1 text-sm text-content-dim">
          Let external agents connect to this workspace over the Model Context Protocol. Tokens are
          personal: you only see and manage the ones you created, and they act as you (or as a
          workspace cybo) with those permissions.
        </p>
      </div>
    {:else}
      <p class="text-[13px] text-content-muted">
        Let external agents connect to this workspace over the Model Context Protocol. Tokens are personal and act as you (or as a workspace cybo).
      </p>
    {/if}

    {#if loading && !data}
      <div class="text-sm text-content-dim">Loading…</div>
    {:else if data}
      <!-- Master switch -->
      <div class="flex items-center justify-between rounded-lg border border-edge bg-sidebar-bg p-4">
        <div>
          <div class="text-sm font-medium text-content">Allow external agents</div>
          <div class="text-xs text-content-dim">
            When off, every MCP token is refused — a quick kill-switch for all external access.
            {#if !canManageWorkspace}Only owners and admins can change this.{/if}
          </div>
        </div>
        <Switch
          checked={data.enabled}
          onCheckedChange={setEnabled}
          disabled={!canManageWorkspace}
          aria-label="Toggle external MCP access for this workspace"
        />
      </div>

      <!-- Connection URL -->
      <div class="rounded-lg border border-edge bg-sidebar-bg p-4">
        <div class="text-sm font-medium text-content">Connection URL</div>
        <div class="text-xs text-content-dim">Paste this into your agent's MCP config, with a token as the bearer.</div>
        <div class="mt-2 flex items-center gap-2">
          <code class="flex-1 truncate rounded border border-edge bg-bg px-2 py-1.5 text-xs text-content">
            {data.connectionUrl ?? "RELAY_PUBLIC_URL not configured on the relay"}
          </code>
          {#if data.connectionUrl}
            <button
              onclick={() => copy(data!.connectionUrl!, "url")}
              class="rounded-md border border-edge px-3 py-1.5 text-xs text-content hover:bg-[var(--sidebar-hover)]"
            >
              {copied === "url" ? "Copied" : "Copy"}
            </button>
          {/if}
        </div>

        <!-- mcp.json snippet with a <token> placeholder (the real value is only
             shown once, at creation — we never store the plaintext). -->
        <div class="mt-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-content-dim">
              Client config (mcp.json) — replace &lt;token&gt; with one of your tokens
            </span>
            <button
              onclick={() => copy(placeholderJson, "tmpl")}
              class="shrink-0 rounded-md border border-edge px-3 py-1 text-xs text-content hover:bg-[var(--sidebar-hover)]"
            >
              {copied === "tmpl" ? "Copied" : "Copy JSON"}
            </button>
          </div>
          <pre
            class="mt-1.5 overflow-x-auto rounded border border-edge bg-bg px-3 py-2 text-[11px] leading-relaxed text-content">{placeholderJson}</pre>
        </div>
      </div>

      <!-- Tokens -->
      <div class="rounded-lg border border-edge bg-sidebar-bg">
        <div class="flex items-center justify-between border-b border-edge px-4 py-3">
          <div class="text-sm font-medium text-content">Tokens</div>
          <button
            onclick={openDialog}
            class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            Create token
          </button>
        </div>

        {#if data.tokens.length === 0}
          <div class="px-4 py-6 text-center text-sm text-content-dim">No tokens yet.</div>
        {:else}
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-edge text-left text-xs text-content-dim">
                <th class="px-4 py-2 font-medium">Name</th>
                <th class="px-4 py-2 font-medium">Acts as</th>
                <th class="px-4 py-2 font-medium">Scopes</th>
                <th class="px-4 py-2 font-medium">Last used</th>
                <th class="px-4 py-2 font-medium">Enabled</th>
                <th class="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each data.tokens as t (t.id)}
                <tr class="border-b border-edge/50 last:border-0">
                  <td class="px-4 py-2 text-content">{t.name}</td>
                  <td class="px-4 py-2 text-content-dim">
                    <span class="text-xs">{t.identityType}</span> · {identityLabel(t)}
                  </td>
                  <td class="px-4 py-2 text-content-dim">{t.scopes.join(", ")}</td>
                  <td class="px-4 py-2 text-content-dim">{fmtDate(t.lastUsedAt)}</td>
                  <td class="px-4 py-2">
                    <button
                      onclick={() => toggleToken(t)}
                      class={[
                        "rounded px-2 py-0.5 text-xs",
                        t.enabled
                          ? "bg-green-500/15 text-green-500"
                          : "bg-edge text-content-dim",
                      ]}
                    >
                      {t.enabled ? "on" : "off"}
                    </button>
                  </td>
                  <td class="px-4 py-2 text-right">
                    <button
                      onclick={() => revokeToken(t)}
                      class="text-xs text-error hover:underline"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- Tools reference -->
      <div class="rounded-lg border border-edge bg-sidebar-bg p-4">
        <div class="text-sm font-medium text-content">Available tools</div>
        <div class="mt-2 space-y-1.5">
          {#each TOOLS as tool (tool.name)}
            <div class="flex items-baseline gap-2 text-xs">
              <code class="text-content">{tool.name}</code>
              <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-content-dim">{tool.scope}</span>
              <span class="text-content-dim">{tool.desc}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Inbound webhooks -->
    <div class="mt-6 space-y-2 border-t border-edge pt-5">
      <h2 class="text-sm font-semibold text-content">Inbound webhooks</h2>
      <p class="text-xs text-content-dim">
        Let an external service (CI, GitHub, a script) post into a channel. POST a JSON body
        {'{ "text": "…", "username": "…" }'} to the URL below, authenticated with a
        <strong>write</strong>-scoped token from above — as
        <code class="text-content">Authorization: Bearer &lt;token&gt;</code> or a
        <code class="text-content">?token=</code> query param.
      </p>
      {#if workspaceState.channels.length > 0}
        <label class="block">
          <span class="text-xs font-medium text-content-dim">Channel</span>
          <select
            bind:value={webhookChannelId}
            class="mt-1 w-full rounded-md border border-edge bg-sidebar-bg px-3 py-1.5 text-[16px] sm:text-sm text-content"
          >
            {#each workspaceState.channels as ch (ch.id)}
              <option value={ch.id}>#{ch.name}</option>
            {/each}
          </select>
        </label>
        <div class="flex items-center gap-2">
          <code
            class="flex-1 truncate rounded border border-edge bg-bg px-2 py-1.5 text-xs text-content"
          >
            {webhookUrl}
          </code>
          <button
            onclick={() => copy(webhookUrl, "whurl")}
            class="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs text-content hover:bg-[var(--sidebar-hover)]"
          >
            {copied === "whurl" ? "Copied" : "Copy URL"}
          </button>
        </div>
        <div class="flex items-start gap-2">
          <pre
            class="flex-1 overflow-x-auto rounded border border-edge bg-sidebar-bg px-3 py-2 text-[11px] leading-relaxed text-content">{webhookCurl}</pre>
          <button
            onclick={() => copy(webhookCurl, "whcurl")}
            class="shrink-0 rounded-md border border-edge px-3 py-1 text-xs text-content hover:bg-[var(--sidebar-hover)]"
          >
            {copied === "whcurl" ? "Copied" : "Copy"}
          </button>
        </div>
      {:else}
        <p class="text-xs text-content-dim">Create a channel first to get a webhook URL.</p>
      {/if}
    </div>

    {#if msg}
      <div class="text-sm text-content-dim">{msg}</div>
    {/if}
  </div>
</div>

<!-- Create-token dialog: shadcn Dialog — the old hand-rolled panel used bg-bg,
     a token with no --color-bg mapping, so its background rendered transparent. -->
<Dialog bind:open={dialogOpen}>
  <!-- While the create request is in flight, dismissal is blocked at the
       source (bits-ui behaviors) instead of re-opening from onOpenChange,
       which would flicker the closing transition and desync the focus trap. -->
  <DialogContent
    class="sm:max-w-md"
    showCloseButton={!creating}
    escapeKeydownBehavior={creating ? "ignore" : "close"}
    interactOutsideBehavior={creating ? "ignore" : "close"}
  >
    {#if createdToken}
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
        <DialogDescription>
          Copy it now — it is shown only once and cannot be retrieved again.
        </DialogDescription>
      </DialogHeader>
      <div class="flex min-w-0 items-center gap-2">
          <code class="min-w-0 flex-1 break-all rounded border border-edge bg-sidebar-bg px-2 py-1.5 text-xs text-content">
            {createdToken}
          </code>
          <button
            onclick={() => copy(createdToken, "token")}
            class="shrink-0 rounded-md border border-edge px-3 py-1.5 text-xs text-content hover:bg-[var(--sidebar-hover)]"
          >
            {copied === "token" ? "Copied" : "Copy"}
          </button>
        </div>

      <!-- Ready-to-paste MCP client config (mcpServers JSON) -->
      <div class="mt-2 min-w-0">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-content-dim">
            Connection config — paste into your MCP client (e.g. ~/.claude/mcp.json)
          </span>
          <button
            onclick={() => copy(connectionJson, "json")}
            class="shrink-0 rounded-md border border-edge px-3 py-1 text-xs text-content hover:bg-[var(--sidebar-hover)]"
          >
            {copied === "json" ? "Copied" : "Copy JSON"}
          </button>
        </div>
        <pre
          class="mt-1.5 overflow-x-auto rounded border border-edge bg-sidebar-bg px-3 py-2 text-[11px] leading-relaxed text-content">{connectionJson}</pre>
      </div>

      <DialogFooter>
        <button
          onclick={() => (dialogOpen = false)}
          class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground"
        >
          Done
        </button>
      </DialogFooter>
    {:else}
      <DialogHeader>
        <DialogTitle>Create MCP token</DialogTitle>
      </DialogHeader>
      <div class="space-y-4">
          <label class="block">
            <span class="text-xs font-medium text-content-dim">Name</span>
            <input
              bind:value={newName}
              placeholder="e.g. Claude Desktop"
              class="mt-1 w-full rounded-md border border-edge bg-sidebar-bg px-3 py-1.5 text-[16px] sm:text-sm text-content"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-content-dim">Acts as</span>
            <select
              bind:value={newIdentityKey}
              class="mt-1 w-full rounded-md border border-edge bg-sidebar-bg px-3 py-1.5 text-[16px] sm:text-sm text-content"
            >
              {#if data}
                {#each data.identities.cybos as c (c.id)}
                  <option value={`cybo:${c.id}`}>cybo · {c.name}</option>
                {/each}
                {#if data.identities.self}
                  <option value={`user:${data.identities.self.id}`}>
                    user · {data.identities.self.name} (you)
                  </option>
                {/if}
              {/if}
            </select>
          </label>

          <div>
            <span class="text-xs font-medium text-content-dim">Scopes</span>
            <div class="mt-1 flex gap-4">
              <label class="flex items-center gap-2 text-sm text-content">
                <input type="checkbox" bind:checked={scopeRead} /> read
              </label>
              <label class="flex items-center gap-2 text-sm text-content">
                <input type="checkbox" bind:checked={scopeWrite} /> write
              </label>
            </div>
          </div>

          <label class="block">
            <span class="text-xs font-medium text-content-dim">Expires in (days, optional)</span>
            <input
              bind:value={expiresInDays}
              inputmode="numeric"
              placeholder="never"
              class="mt-1 w-full rounded-md border border-edge bg-sidebar-bg px-3 py-1.5 text-[16px] sm:text-sm text-content"
            />
          </label>
        </div>

      <DialogFooter>
        <button
          onclick={() => (dialogOpen = false)}
          disabled={creating}
          class="rounded-md border border-edge px-4 py-1.5 text-sm text-content hover:bg-[var(--sidebar-hover)]"
        >
          Cancel
        </button>
        <button
          onclick={createToken}
          disabled={creating}
          class="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create"}
        </button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
