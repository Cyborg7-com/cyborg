<script lang="ts">
  // Inbound-webhook management for a channel — a clean, GitHub-style config.
  //
  // The receive endpoint (POST /api/webhooks/:channelId) lives on the relay and
  // authenticates with a WRITE-scoped MCP token (the bearer). This panel layers
  // the config ON TOP: an endpoint URL, an optional signing secret (HMAC
  // X-Hub-Signature-256), an event filter, an active toggle — plus a collapsible
  // setup guide and a Recent Deliveries log. Config RPCs are channel-admin gated.
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
  } from "$lib/components/ui/collapsible/index.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { cn } from "$lib/utils.js";
  import { authState, client, workspaceState } from "$lib/state/app.svelte.js";
  import {
    relayHttpBaseFromWsUrl,
    type McpToken,
    type Webhook,
    type WebhookDelivery,
  } from "$lib/core/client.js";
  import { getSavedSession } from "$lib/core/state.svelte.js";
  import type { Channel } from "$lib/core/types.js";

  // `isAdmin` gates the management surface. Non-admin members see only the
  // read-only parts (endpoint URL, payload formats, setup) and never call the
  // channel-admin-gated webhook/token RPCs.
  let { channel, isAdmin = true }: { channel: Channel; isAdmin?: boolean } = $props();

  const wsId = $derived(workspaceState.current?.id ?? "");

  // Webhook endpoint = the relay's HTTP origin + /api/webhooks/:channelId.
  const webhookUrl = $derived.by(() => {
    const saved = getSavedSession();
    if (!saved) return "";
    return `${relayHttpBaseFromWsUrl(saved.url)}/api/webhooks/${channel.id}`;
  });

  // ─── State ───────────────────────────────────────────────────────
  let loading = $state(true);
  let error = $state<string | null>(null);
  let copied = $state<string | null>(null);

  let webhooks = $state<Webhook[]>([]);
  let tokens = $state<McpToken[]>([]);
  let selfIdentity = $state<{ id: string; name: string } | null>(null);
  let cyboIdentities = $state<Array<{ id: string; name: string }>>([]);

  // One config form per channel (one target, one config).
  const webhook = $derived(webhooks[0] ?? null);

  // Newly minted secrets/tokens — shown ONCE.
  let createdSecret = $state<string | null>(null);
  let createdToken = $state<string | null>(null);

  // Config draft. `eventScope` is the UI model: forward everything, or only a
  // chosen set. Release is just one selectable event among equals — no event type
  // is privileged in the picker (releases simply render richer once they arrive).
  let eventScope = $state<"all" | "specific">("specific");
  let formEvents = $state<string[]>(["release"]);
  let formActive = $state(true);
  let mutating = $state(false);

  // The events a user can filter on. `release` renders as a rich card; the rest
  // post as text today. Ordered, not release-first, to keep the picker neutral.
  const SELECTABLE_EVENTS = [
    "push",
    "pull_request",
    "issues",
    "release",
    "workflow_run",
    "deployment",
  ];

  // Map the UI scope onto the server's (eventMode, events) shape.
  function eventConfig(): { eventMode: "all" | "select"; events: string[] } {
    return eventScope === "all"
      ? { eventMode: "all", events: [] }
      : { eventMode: "select", events: formEvents };
  }

  // Deliveries.
  let deliveries = $state<WebhookDelivery[]>([]);
  let deliveriesLoading = $state(false);
  let expandedDelivery = $state<string | null>(null);

  // Destructive-confirm dialogs.
  let confirmRotate = $state(false);
  let confirmRemoveSecret = $state(false);
  let confirmDeleteWebhook = $state(false);
  let confirmRevokeToken = $state<string | null>(null);

  const writeTokens = $derived(tokens.filter((t) => t.scopes.includes("write")));

  // ─── Load ────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    if (!wsId) return;
    loading = true;
    error = null;
    try {
      const [mcp, whs] = await Promise.all([
        client.mcpList(wsId),
        client.webhookList(wsId, channel.id),
      ]);
      tokens = mcp.tokens;
      selfIdentity = mcp.identities.self;
      cyboIdentities = mcp.identities.cybos;
      webhooks = whs;
      const w = whs[0];
      if (w) {
        // Legacy "release" eventMode maps to the specific picker with release on.
        eventScope = w.eventMode === "all" ? "all" : "specific";
        formEvents = w.events.length ? w.events : ["release"];
        formActive = w.active;
        void loadDeliveries(w.id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load webhooks";
    } finally {
      loading = false;
    }
  }

  async function loadDeliveries(webhookId: string): Promise<void> {
    deliveriesLoading = true;
    try {
      deliveries = await client.webhookListDeliveries(wsId, webhookId);
    } catch {
      // Non-fatal — the deliveries log is best-effort.
    } finally {
      deliveriesLoading = false;
    }
  }

  $effect(() => {
    if (wsId && isAdmin) void load();
  });

  // ─── Copy ────────────────────────────────────────────────────────
  async function copy(text: string, key: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = null;
      }, 1500);
    } catch {
      // Clipboard blocked — the field stays selectable for manual copy.
    }
  }

  // ─── Webhook config mutations ────────────────────────────────────
  async function createWebhook(generateSecret: boolean): Promise<void> {
    if (!wsId || mutating) return;
    mutating = true;
    error = null;
    try {
      const res = await client.webhookCreate(wsId, channel.id, {
        name: `#${channel.name}`,
        ...eventConfig(),
        active: formActive,
        generateSecret,
      });
      if (res.secret) createdSecret = res.secret;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create webhook";
    } finally {
      mutating = false;
    }
  }

  async function saveConfig(): Promise<void> {
    if (!wsId || !webhook || mutating) return;
    mutating = true;
    error = null;
    try {
      await client.webhookUpdate(wsId, webhook.id, { ...eventConfig(), active: formActive });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save config";
    } finally {
      mutating = false;
    }
  }

  async function toggleActive(next: boolean): Promise<void> {
    formActive = next;
    if (!webhook) return;
    await client.webhookUpdate(wsId, webhook.id, { active: next }).catch((e) => {
      error = e instanceof Error ? e.message : "Failed to toggle";
    });
    await load();
  }

  async function rotateSecret(clear: boolean): Promise<void> {
    confirmRotate = false;
    confirmRemoveSecret = false;
    if (!wsId || !webhook || mutating) return;
    mutating = true;
    try {
      const res = await client.webhookRotateSecret(wsId, webhook.id, clear);
      createdSecret = res.secret;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to rotate secret";
    } finally {
      mutating = false;
    }
  }

  async function deleteWebhook(): Promise<void> {
    confirmDeleteWebhook = false;
    if (!wsId || !webhook) return;
    mutating = true;
    try {
      await client.webhookDelete(wsId, webhook.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to delete webhook";
    } finally {
      mutating = false;
    }
  }

  function toggleEventInList(ev: string): void {
    formEvents = formEvents.includes(ev)
      ? formEvents.filter((e) => e !== ev)
      : [...formEvents, ev];
  }

  // ─── Deliveries ──────────────────────────────────────────────────
  async function redeliver(deliveryId: string): Promise<void> {
    if (!wsId) return;
    try {
      await client.webhookRedeliver(wsId, deliveryId);
      if (webhook) await loadDeliveries(webhook.id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to redeliver";
    }
  }

  function deliveryTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  }

  // ─── Tokens (bearer credential) ──────────────────────────────────
  function pickTokenIdentity():
    | { identityType: "user"; identityId: string }
    | { identityType: "cybo"; identityId: string }
    | null {
    // Prefer the fetched `self` when the mcp_list load succeeded, then a cybo
    // identity (a cybo-owned token when the load returned no self but has cybos).
    if (selfIdentity) return { identityType: "user", identityId: selfIdentity.id };
    const cybo = cyboIdentities[0];
    if (cybo) return { identityType: "cybo", identityId: cybo.id };
    // Last resort — the mcp_list fetch hiccuped (timeout / transient relay error)
    // so `selfIdentity` is null. A user token must act as the caller THEMSELVES
    // (the server enforces identityId === your own user id: mcp_create_token "a user
    // token can only act as yourself"), so the authenticated session is an
    // authoritative substitute — minting isn't blocked by a flaky identity fetch.
    if (authState.user?.id) return { identityType: "user", identityId: authState.user.id };
    return null;
  }

  async function createToken(): Promise<void> {
    if (!wsId || mutating) return;
    const identity = pickTokenIdentity();
    if (!identity) {
      error = "No identity available to own this token.";
      return;
    }
    mutating = true;
    error = null;
    try {
      const res = await client.mcpCreateToken(wsId, {
        name: `Webhook · #${channel.name}`,
        ...identity,
        scopes: ["write"],
      });
      createdToken = res.token;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to create token";
    } finally {
      mutating = false;
    }
  }

  async function revokeToken(tokenId: string): Promise<void> {
    confirmRevokeToken = null;
    if (!wsId) return;
    try {
      await client.mcpRevokeToken(wsId, tokenId);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to revoke token";
    }
  }

  async function toggleToken(tokenId: string, enabled: boolean): Promise<void> {
    if (!wsId) return;
    try {
      await client.mcpToggleToken(wsId, tokenId, enabled);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update token";
    }
  }

  function lastUsedLabel(t: McpToken): string {
    return t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "Never used";
  }

  // ─── Setup docs ──────────────────────────────────────────────────
  // A signed curl that computes the HMAC the way GitHub does.
  const curlExample = $derived(
    webhookUrl
      ? `BODY='{"text":"hello from CI"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')"
curl -X POST "${webhookUrl}" \\
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "X-Hub-Signature-256: $SIG" \\
  -d "$BODY"`
      : "",
  );

  // GitHub Actions workflow: on a published release, POST the full release event
  // so the relay renders the rich release card. GH expressions stay literal.
  const ghActionsExample = $derived(
    webhookUrl
      ? `name: Notify Cyborg7
on:
  release:
    types: [published]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Post release to Cyborg7
        env:
          SECRET: \${{ secrets.CYBORG7_WEBHOOK_SECRET }}
        run: |
          BODY=$(jq -c '{action, release, repository}' "$GITHUB_EVENT_PATH")
          SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
          curl -X POST "${webhookUrl}" \\
            -H "Authorization: Bearer \${{ secrets.CYBORG7_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -H "X-GitHub-Event: release" \\
            -H "X-Hub-Signature-256: $SIG" \\
            --data-raw "$BODY"`
      : "",
  );

  let setupOpen = $state(false);
  let ghOpen = $state(false);
  let curlOpen = $state(false);
  let formatsOpen = $state(false);

  // Shared chevron classes for collapsible triggers.
  const chevron = "h-3.5 w-3.5 shrink-0 text-content-muted transition-transform";

  // ─── Per-event payload reference ─────────────────────────────────
  // Real GitHub webhooks send these automatically. For a custom sender, set the
  // `X-GitHub-Event` header and POST a payload shaped like this to get each card.
  // Only the fields shown are read; everything else is ignored.
  interface EventFormat {
    id: string;
    label: string;
    note: string;
    payload: string;
  }
  const EVENT_FORMATS: EventFormat[] = [
    {
      id: "release",
      label: "release",
      note: "Rich release card: tag, name, markdown changelog, pre-release pill, author.",
      payload: `{
  "action": "published",
  "release": {
    "tag_name": "v2.4.0",
    "name": "Spring cleaning",
    "body": "## Changelog\\n- Fixed the thing\\n- Added the other",
    "html_url": "https://github.com/owner/repo/releases/tag/v2.4.0",
    "prerelease": false,
    "author": { "login": "octocat", "avatar_url": "https://…/u/1?v=4" },
    "published_at": "2026-06-11T12:00:00Z"
  },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
    {
      id: "pull_request",
      label: "pull_request",
      note: "PR card, colored by state — open (green), merged (purple), closed (red), draft (gray).",
      payload: `{
  "action": "opened",
  "pull_request": {
    "number": 123, "title": "Add the new dashboard",
    "html_url": "https://github.com/owner/repo/pull/123",
    "state": "open", "merged": false, "draft": false,
    "user": { "login": "octocat", "avatar_url": "https://…/u/1?v=4" },
    "head": { "ref": "feat/dashboard" }, "base": { "ref": "main" },
    "additions": 482, "deletions": 37, "changed_files": 12,
    "labels": [{ "name": "feature" }], "body": "Adds the dashboard."
  },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
    {
      id: "issues",
      label: "issues",
      note: "Issue card, colored by state — open (green), closed (purple/gray).",
      payload: `{
  "action": "opened",
  "issue": {
    "number": 42, "title": "Dark mode flickers on toggle",
    "html_url": "https://github.com/owner/repo/issues/42",
    "state": "open",
    "user": { "login": "octocat", "avatar_url": "https://…/u/1?v=4" },
    "labels": [{ "name": "bug" }, { "name": "ui" }],
    "comments": 3, "body": "Steps to reproduce…"
  },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
    {
      id: "push",
      label: "push",
      note: "Push card: branch + a list of commits (first 5). Force-pushes flagged red.",
      payload: `{
  "ref": "refs/heads/main",
  "forced": false,
  "compare": "https://github.com/owner/repo/compare/abc123...def456",
  "commits": [
    { "id": "a1b2c3d4", "message": "Fix the broken thing",
      "url": "https://github.com/owner/repo/commit/a1b2c3d4",
      "author": { "name": "octocat" } }
  ],
  "head_commit": { "timestamp": "2026-06-11T12:00:00Z" },
  "pusher": { "name": "octocat" },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
    {
      id: "workflow_run",
      label: "workflow_run",
      note: "CI card on completion, colored by conclusion — success (green), failure (red).",
      payload: `{
  "action": "completed",
  "workflow_run": {
    "name": "CI", "status": "completed", "conclusion": "success",
    "html_url": "https://github.com/owner/repo/actions/runs/123",
    "head_branch": "main", "run_number": 87, "event": "push",
    "actor": { "login": "octocat", "avatar_url": "https://…/u/1?v=4" }
  },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
    {
      id: "deployment_status",
      label: "deployment_status",
      note: "Deployment card, colored by state — success (green), failure (red), pending (yellow).",
      payload: `{
  "deployment_status": {
    "state": "success", "environment": "production",
    "environment_url": "https://app.example.com",
    "description": "Deployed v2.4.0",
    "creator": { "login": "octocat", "avatar_url": "https://…/u/1?v=4" }
  },
  "deployment": { "ref": "main", "environment": "production" },
  "repository": { "full_name": "owner/repo", "html_url": "https://github.com/owner/repo" }
}`,
    },
  ];
  let formatEventId = $state("release");
  const formatActive = $derived(
    EVENT_FORMATS.find((e) => e.id === formatEventId) ?? EVENT_FORMATS[0],
  );
</script>

<div class="min-w-0 space-y-6 text-content">
  {#if error}
    <p class="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">{error}</p>
  {/if}

  <!-- ── Endpoint ── -->
  <section class="space-y-2">
    <div>
      <h3 class="text-sm font-semibold">Endpoint</h3>
      <p class="text-xs text-content-muted">
        Point any service at this URL. GitHub events render as rich cards — releases, pull
        requests, issues, pushes, CI runs and more.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <input
        readonly
        value={webhookUrl}
        aria-label="Payload URL"
        class="min-w-0 flex-1 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 font-mono text-[12px]"
      />
      <Button variant="outline" size="sm" onclick={() => copy(webhookUrl, "url")} disabled={!webhookUrl}>
        {copied === "url" ? "Copied" : "Copy"}
      </Button>
    </div>
  </section>

  {#if !isAdmin}
    <p
      class="rounded-md border border-edge bg-surface-alt/40 px-3 py-2 text-xs text-content-muted"
    >
      Webhook configuration is managed by channel admins. Below is how events post to
      #{channel.name}.
    </p>
  {/if}

  {#if isAdmin}
  <!-- ── One-time secret reveal ── -->
  {#if createdSecret}
    <div class="space-y-2 rounded-lg border border-accent/40 bg-accent/10 p-3">
      <div class="text-sm font-medium">Signing secret — copy it now</div>
      <p class="text-xs text-content-muted">
        Shown only once. Store it as <code>CYBORG7_WEBHOOK_SECRET</code> — it signs every delivery.
      </p>
      <div class="flex items-center gap-2">
        <input
          readonly
          value={createdSecret}
          aria-label="Signing secret"
          class="min-w-0 flex-1 rounded-md border border-edge bg-surface px-2.5 py-1.5 font-mono text-[12px]"
        />
        <Button variant="outline" size="sm" onclick={() => copy(createdSecret ?? "", "secret")}>
          {copied === "secret" ? "Copied" : "Copy"}
        </Button>
      </div>
      <Button variant="ghost" size="sm" class="text-content-muted" onclick={() => (createdSecret = null)}>
        Done
      </Button>
    </div>
  {/if}

  <!-- ── Configuration ── -->
  {#if loading}
    <p class="py-3 text-center text-sm text-content-muted">Loading…</p>
  {:else}
    <section class="space-y-5 rounded-lg border border-edge bg-surface-alt/40 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold">Configuration</h3>
        {#if webhook}
          <label class="flex cursor-pointer items-center gap-2">
            <span class="text-xs font-medium {formActive ? 'text-content' : 'text-content-muted'}">
              {formActive ? "Active" : "Paused"}
            </span>
            <Switch checked={formActive} onCheckedChange={(v) => void toggleActive(v)} />
          </label>
        {/if}
      </div>

      <!-- Events -->
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-medium">Events</span>
          <div class="inline-flex rounded-md border border-edge p-0.5">
            <button
              type="button"
              onclick={() => (eventScope = "all")}
              class={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                eventScope === "all" ? "bg-accent text-accent-foreground" : "text-content-muted hover:text-content",
              )}
            >
              All events
            </button>
            <button
              type="button"
              onclick={() => (eventScope = "specific")}
              class={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                eventScope === "specific" ? "bg-accent text-accent-foreground" : "text-content-muted hover:text-content",
              )}
            >
              Choose
            </button>
          </div>
        </div>

        {#if eventScope === "all"}
          <p class="text-xs text-content-muted">
            Everything posts — releases as cards, other events as text.
          </p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each SELECTABLE_EVENTS as ev (ev)}
              {@const on = formEvents.includes(ev)}
              <button
                type="button"
                onclick={() => toggleEventInList(ev)}
                aria-pressed={on}
                class={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                  on
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-edge text-content-dim hover:border-edge-light hover:text-content",
                )}
              >
                {ev}
              </button>
            {/each}
          </div>
          <p class="text-xs text-content-muted">
            {formEvents.length === 0
              ? "Nothing selected — pick at least one event."
              : `Only these post to #${channel.name}.`}
          </p>
        {/if}
      </div>

      <!-- Secret -->
      <div class="space-y-1.5">
        <span class="text-xs font-medium">Signing secret</span>
        {#if webhook}
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant={webhook.hasSecret ? "default" : "secondary"}>
              {webhook.hasSecret ? "Secret set" : "No secret"}
            </Badge>
            <Button variant="outline" size="sm" disabled={mutating} onclick={() => (confirmRotate = true)}>
              {webhook.hasSecret ? "Rotate" : "Set secret"}
            </Button>
            {#if webhook.hasSecret}
              <Button
                variant="ghost"
                size="sm"
                class="text-content-muted"
                disabled={mutating}
                onclick={() => (confirmRemoveSecret = true)}
              >
                Remove
              </Button>
            {/if}
          </div>
          <p class="text-xs text-content-muted">
            HMAC-SHA256 over the body → <code>X-Hub-Signature-256</code>. Bad signatures are rejected
            <code>401</code>.
          </p>
        {:else}
          <p class="text-xs text-content-dim">Created with the webhook below.</p>
        {/if}
      </div>

      <!-- Actions -->
      <div class="flex flex-wrap items-center gap-2 border-t border-edge/60 pt-3">
        {#if webhook}
          <Button size="sm" disabled={mutating} onclick={saveConfig}>
            {mutating ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="text-error hover:text-error"
            disabled={mutating}
            onclick={() => (confirmDeleteWebhook = true)}
          >
            Delete webhook
          </Button>
        {:else}
          <Button size="sm" disabled={mutating} onclick={() => void createWebhook(true)}>
            {mutating ? "Creating…" : "Create webhook"}
          </Button>
          <Button variant="outline" size="sm" disabled={mutating} onclick={() => void createWebhook(false)}>
            Without secret
          </Button>
        {/if}
      </div>
    </section>
  {/if}
  {/if}

  <!-- ── Payload formats per event (what to send for each card) ── -->
  <Collapsible bind:open={formatsOpen} class="rounded-lg border border-edge bg-surface-alt/40">
    <CollapsibleTrigger
      class="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm font-semibold"
    >
      <svg
        class={cn(chevron, formatsOpen && "rotate-90")}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      Payload formats per event
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="space-y-2.5 border-t border-edge/60 px-3 py-3">
        <p class="text-xs text-content-muted">
          GitHub sends these automatically. From a custom service, set the
          <code>X-GitHub-Event</code> header and POST a payload shaped like below — only the shown
          fields are read.
        </p>
        <div class="flex flex-wrap gap-1.5">
          {#each EVENT_FORMATS as e (e.id)}
            {@const on = formatEventId === e.id}
            <button
              type="button"
              onclick={() => (formatEventId = e.id)}
              aria-pressed={on}
              class={cn(
                "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                on
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-edge text-content-dim hover:border-edge-light hover:text-content",
              )}
            >
              {e.label}
            </button>
          {/each}
        </div>
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate font-mono text-[12px] text-content-muted">
              X-GitHub-Event: <span class="text-content">{formatActive.id}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              class="h-7 shrink-0 px-2 text-xs"
              onclick={() =>
                copy(`X-GitHub-Event: ${formatActive.id}\n\n${formatActive.payload}`, "fmt")}
            >
              {copied === "fmt" ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre
            class="max-w-full overflow-x-auto rounded-md border border-edge bg-surface px-2.5 py-1.5 font-mono text-[12px] whitespace-pre text-content">{formatActive.payload}</pre>
          <p class="text-xs text-content-muted">{formatActive.note}</p>
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>

  {#if isAdmin}
  <!-- ── Tokens ── -->
  <section class="space-y-2">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold">Tokens</h3>
        <p class="text-xs text-content-muted">
          The bearer credential — sent as <code>Authorization: Bearer</code> or <code>?token=</code>.
        </p>
      </div>
      <Button size="sm" onclick={createToken} disabled={mutating || !wsId}>Create token</Button>
    </div>

    {#if createdToken}
      <div class="space-y-2 rounded-lg border border-accent/40 bg-accent/10 p-3">
        <div class="text-sm font-medium">Token created — copy it now</div>
        <p class="text-xs text-content-muted">
          Shown only once. Store it as <code>CYBORG7_WEBHOOK_TOKEN</code>.
        </p>
        <div class="flex items-center gap-2">
          <input
            readonly
            value={createdToken}
            aria-label="New webhook token"
            class="min-w-0 flex-1 rounded-md border border-edge bg-surface px-2.5 py-1.5 font-mono text-[12px]"
          />
          <Button variant="outline" size="sm" onclick={() => copy(createdToken ?? "", "newtoken")}>
            {copied === "newtoken" ? "Copied" : "Copy"}
          </Button>
        </div>
        <Button variant="ghost" size="sm" class="text-content-muted" onclick={() => (createdToken = null)}>
          Done
        </Button>
      </div>
    {/if}

    {#if writeTokens.length === 0}
      <p class="rounded-md border border-dashed border-edge py-3 text-center text-xs text-content-muted">
        No tokens yet — create one to authenticate posts.
      </p>
    {:else}
      <div class="space-y-1.5">
        {#each writeTokens as t (t.id)}
          <div class="flex items-center gap-3 rounded-lg border border-edge px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-[13px] font-medium">{t.name}</span>
                {#if !t.enabled}
                  <Badge variant="secondary">Disabled</Badge>
                {/if}
              </div>
              <div class="text-[11px] text-content-muted">{lastUsedLabel(t)}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs"
              onclick={() => toggleToken(t.id, !t.enabled)}
            >
              {t.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-xs text-error hover:text-error"
              onclick={() => (confirmRevokeToken = t.id)}
            >
              Revoke
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ── Recent deliveries ── -->
  {#if webhook}
    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold">Recent deliveries</h3>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-xs"
          disabled={deliveriesLoading}
          onclick={() => webhook && loadDeliveries(webhook.id)}
        >
          {deliveriesLoading ? "…" : "Refresh"}
        </Button>
      </div>

      {#if deliveries.length === 0}
        <p class="rounded-md border border-dashed border-edge py-4 text-center text-xs text-content-muted">
          No deliveries yet — POST to the endpoint to see history.
        </p>
      {:else}
        <div class="space-y-1.5">
          {#each deliveries as d (d.id)}
            <div class="overflow-hidden rounded-lg border border-edge">
              <button
                type="button"
                class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
                onclick={() => (expandedDelivery = expandedDelivery === d.id ? null : d.id)}
              >
                <span
                  class="h-2 w-2 shrink-0 rounded-full"
                  class:bg-online={d.ok}
                  class:bg-error={!d.ok}
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <code class="text-[12px]">{d.event ?? "—"}{d.action ? `.${d.action}` : ""}</code>
                    {#if d.redeliveredFrom}
                      <Badge variant="secondary">redelivered</Badge>
                    {/if}
                  </span>
                  <span class="text-[11px] text-content-muted">
                    {deliveryTime(d.createdAt)} · HTTP {d.responseStatus}
                  </span>
                </span>
                <svg
                  class={cn(chevron, expandedDelivery === d.id && "rotate-90")}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
              </button>
              {#if expandedDelivery === d.id}
                <div class="space-y-2 border-t border-edge bg-surface-alt/30 px-3 py-2">
                  <div>
                    <div class="mb-1 text-[11px] font-semibold text-content-muted">Request</div>
                    <pre
                      class="max-w-full rounded-md border border-edge bg-surface px-2 py-1 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere] text-content-dim">{d.requestBody ??
                        "(empty)"}</pre>
                  </div>
                  <div>
                    <div class="mb-1 text-[11px] font-semibold text-content-muted">Response</div>
                    <pre
                      class="max-w-full rounded-md border border-edge bg-surface px-2 py-1 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere] text-content-dim">{d.responseBody ??
                        "(empty)"}</pre>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-7 px-2 text-xs"
                    onclick={() => void redeliver(d.id)}
                  >
                    Redeliver
                  </Button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
  {/if}

  <!-- ── Setup guide (collapsed by default) ── -->
  <Collapsible bind:open={setupOpen} class="rounded-lg border border-edge bg-surface-alt/40">
    <CollapsibleTrigger
      class="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm font-semibold"
    >
      <svg
        class={cn(chevron, setupOpen && "rotate-90")}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      Connect a GitHub repo
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="space-y-3 border-t border-edge/60 px-3 py-3">
        <ol class="list-decimal space-y-1 pl-4 text-xs text-content-muted">
          <li>Copy the <span class="font-medium text-content">endpoint URL</span> and create a <span class="font-medium text-content">token</span> (and secret) above.</li>
          <li>
            Add repo secrets <code>CYBORG7_WEBHOOK_TOKEN</code> and <code>CYBORG7_WEBHOOK_SECRET</code>.
          </li>
          <li>Add the workflow below — it fires on <code>release: published</code>.</li>
        </ol>

        <Collapsible bind:open={ghOpen}>
          <CollapsibleTrigger class="flex w-full items-center gap-1.5 text-left text-xs font-medium">
            <svg
              class={cn(chevron, ghOpen && "rotate-90")}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            GitHub Actions workflow
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2 space-y-1.5">
              <div class="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  onclick={() => copy(ghActionsExample, "gh")}
                  disabled={!ghActionsExample}
                >
                  {copied === "gh" ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre
                class="overflow-x-auto rounded-md border border-edge bg-surface px-2.5 py-1.5 font-mono text-[12px] whitespace-pre">{ghActionsExample}</pre>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible bind:open={curlOpen}>
          <CollapsibleTrigger class="flex w-full items-center gap-1.5 text-left text-xs font-medium">
            <svg
              class={cn(chevron, curlOpen && "rotate-90")}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            Test with curl
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2 space-y-1.5">
              <p class="text-xs text-content-muted">
                Set <code>WEBHOOK_TOKEN</code> + <code>WEBHOOK_SECRET</code> in your shell first.
              </p>
              <div class="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  onclick={() => copy(curlExample, "curl")}
                  disabled={!curlExample}
                >
                  {copied === "curl" ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre
                class="overflow-x-auto rounded-md border border-edge bg-surface px-2.5 py-1.5 font-mono text-[12px] whitespace-pre">{curlExample}</pre>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </CollapsibleContent>
  </Collapsible>
</div>

<ConfirmDialog
  open={confirmRotate}
  title={webhook?.hasSecret ? "Rotate signing secret?" : "Set signing secret?"}
  message={webhook?.hasSecret
    ? "The current secret stops working immediately. Update it everywhere that posts to this webhook."
    : "A new secret will sign all deliveries. It is shown once."}
  confirmLabel={webhook?.hasSecret ? "Rotate" : "Set secret"}
  onconfirm={() => void rotateSecret(false)}
  oncancel={() => (confirmRotate = false)}
/>
<ConfirmDialog
  open={confirmRemoveSecret}
  title="Remove signing secret?"
  message="Signature verification is disabled. Anyone who knows the Payload URL and a write token can post to this webhook unsigned. Remove the secret only if you intend to."
  confirmLabel="Remove secret"
  destructive
  onconfirm={() => void rotateSecret(true)}
  oncancel={() => (confirmRemoveSecret = false)}
/>
<ConfirmDialog
  open={confirmDeleteWebhook}
  title="Delete this webhook?"
  message="Its config, secret, and delivery history are removed. The Payload URL stops accepting signed posts."
  confirmLabel="Delete"
  destructive
  onconfirm={() => void deleteWebhook()}
  oncancel={() => (confirmDeleteWebhook = false)}
/>
<ConfirmDialog
  open={confirmRevokeToken !== null}
  title="Revoke this token?"
  message="Anything using it stops working immediately. This can't be undone."
  confirmLabel="Revoke"
  destructive
  onconfirm={() => confirmRevokeToken && void revokeToken(confirmRevokeToken)}
  oncancel={() => (confirmRevokeToken = null)}
/>

<style>
  /* Inline code here is config metadata — header names, env vars, status codes —
     not chat markdown. Override the global loud-red `code` style (app.css uses
     --code-inline-text ≈ #e06c75) with quiet, neutral monospace so the form
     reads as a settings panel, not a wall of red snippets. Scoped: chat keeps
     its red code. `pre` blocks (the workflow/curl) are unaffected — they hold
     plain text, not <code>. */
  code {
    color: var(--color-content-dim);
    background: var(--color-edge);
    border: none;
    border-radius: 0.3rem;
    padding: 0.05em 0.36em;
    font-size: 0.88em;
    font-weight: 500;
  }
</style>
