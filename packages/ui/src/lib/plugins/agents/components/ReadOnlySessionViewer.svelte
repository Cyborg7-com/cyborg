<script lang="ts">
  // Read-only session viewer (#994). Opened from the daemon-detail audit list
  // (sessions-daemon-audit-visibility) for ANY session a daemon owner/admin may
  // audit — active, internal, ephemeral, or another user's. It is STRICTLY
  // read-only and ATTACH-FREE: it issues ONLY the two pure-read RPCs
  // (fetch_agent_timeline + fetch_session_context) and mounts NEITHER a composer
  // NOR any rewind / model / mode / thinking / archive affordance. This is the
  // structural fix for the prior "live:false view" that revived on attach: there
  // is no code path here that can load or revive the session.
  import { onMount } from "svelte";
  import { client } from "$lib/state/app.svelte.js";
  import type { SessionContextBundle } from "$lib/ws-client.js";
  import { fetchAgentTimeline } from "$lib/plugins/agents/state.svelte.js";
  import AgentStreamView from "./AgentStreamView.svelte";
  import * as Collapsible from "$lib/components/ui/collapsible/index.js";

  let {
    workspaceId,
    agentId,
    agentName = "Session",
    provider,
    isCybo = false,
    agentImage = null,
    agentEmoji = null,
  }: {
    workspaceId: string;
    agentId: string;
    agentName?: string;
    provider?: string;
    isCybo?: boolean;
    agentImage?: string | null;
    agentEmoji?: string | null;
  } = $props();

  let context = $state<SessionContextBundle | null>(null);
  let loadingContext = $state(true);
  let contextOpen = $state(true);

  onMount(() => {
    // PURE READS ONLY. fetchAgentTimeline hydrates the transcript from the durable
    // store; fetchSessionContext pulls the captured injected context. Neither
    // attaches, loads, or revives the agent.
    void fetchAgentTimeline(client, agentId);
    void (async () => {
      try {
        context = await client.fetchSessionContext(workspaceId, agentId);
      } catch {
        context = null;
      } finally {
        loadingContext = false;
      }
    })();
  });

  // The framed (routed) prompt only differs from the raw text when a roster +
  // transcript wrapper was prepended; show it as a separate block when present.
  let showFramed = $derived(
    !!context?.routedPrompt && context.routedPrompt !== context.rawPrompt,
  );
</script>

<div class="flex h-full flex-col overflow-hidden" data-testid="readonly-session-viewer">
  <!-- Read-only banner: makes the "you can look but not type" contract explicit. -->
  <div
    class="flex items-center gap-2 border-b px-4 py-2 text-xs"
    style="border-color: var(--color-border); color: var(--color-text-muted);"
    data-testid="readonly-banner"
  >
    <span>Read-only session view — auditing {agentName}. No input.</span>
  </div>

  {#if context !== null}
    <!-- Ephemeral context panel (#994): the injected context this one-turn summon
         received. Absent for non-ephemeral sessions (context === null). -->
    <Collapsible.Root bind:open={contextOpen}>
      <Collapsible.Trigger
        class="flex w-full items-center justify-between px-4 py-2 text-sm font-semibold"
        style="color: var(--color-text);"
        data-testid="context-panel-trigger"
      >
        <span>Injected context</span>
        <span style="color: var(--color-text-muted);">{contextOpen ? "Hide" : "Show"}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div
          class="flex flex-col gap-3 border-b px-4 pb-4"
          style="border-color: var(--color-border);"
          data-testid="context-panel"
        >
          <section data-testid="context-system-prompt">
            <h4 class="mb-1 text-xs font-semibold uppercase" style="color: var(--color-text-muted);">
              System prompt
            </h4>
            <pre
              class="max-h-48 overflow-auto rounded p-2 text-xs whitespace-pre-wrap"
              style="background: var(--color-surface-2); color: var(--color-text);"
            >{context.systemPrompt ?? "(none)"}</pre>
          </section>

          <section data-testid="context-tools">
            <h4 class="mb-1 text-xs font-semibold uppercase" style="color: var(--color-text-muted);">
              Tools available
            </h4>
            {#if context.mcpServers.length === 0}
              <p class="text-xs" style="color: var(--color-text-muted);">(none)</p>
            {:else}
              <ul class="flex flex-col gap-1">
                {#each context.mcpServers as server (server.name)}
                  <li
                    class="rounded px-2 py-1 text-xs"
                    style="background: var(--color-surface-2); color: var(--color-text);"
                  >
                    <span class="font-medium">{server.name}</span>
                    <span style="color: var(--color-text-muted);"> · {server.type}</span>
                    {#if server.toolkit}
                      <span style="color: var(--color-text-muted);"> · {server.toolkit}</span>
                    {/if}
                    {#if server.url}
                      <span style="color: var(--color-text-muted);"> · {server.url}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <section data-testid="context-received-prompt">
            <h4 class="mb-1 text-xs font-semibold uppercase" style="color: var(--color-text-muted);">
              Received prompt
            </h4>
            <pre
              class="max-h-32 overflow-auto rounded p-2 text-xs whitespace-pre-wrap"
              style="background: var(--color-surface-2); color: var(--color-text);"
            >{context.rawPrompt ?? "(none)"}</pre>
            {#if showFramed}
              <h4
                class="mt-2 mb-1 text-xs font-semibold uppercase"
                style="color: var(--color-text-muted);"
              >
                Framed prompt (as routed to the agent)
              </h4>
              <pre
                class="max-h-48 overflow-auto rounded p-2 text-xs whitespace-pre-wrap"
                style="background: var(--color-surface-2); color: var(--color-text);"
              >{context.routedPrompt}</pre>
            {/if}
          </section>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  {:else if loadingContext}
    <div class="px-4 py-2 text-xs" style="color: var(--color-text-muted);">Loading context…</div>
  {/if}

  <!-- Transcript. No rewind callback is passed (read-only) and no composer is
       mounted — the composer is the ONLY revive trigger, so omitting it keeps
       this attach-free. -->
  <div class="min-h-0 flex-1">
    <AgentStreamView
      {agentId}
      {agentName}
      {provider}
      providerLabel={provider}
      {isCybo}
      {agentImage}
      {agentEmoji}
    />
  </div>
</div>
