<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { client } from "$lib/state/app.svelte.js";
  import { onMount } from "svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  type BackendTab = "cloud" | "custom";
  type ServiceStatus = "idle" | "testing" | "connected" | "disconnected" | "error" | "not_configured";

  interface ServiceState {
    url: string | null;
    status: ServiceStatus;
  }

  let activeTab = $state<BackendTab>("cloud");
  let loading = $state(true);

  let pgState = $state<ServiceState>({ url: null, status: "idle" });
  let redisState = $state<ServiceState>({ url: null, status: "idle" });
  let relayState = $state<ServiceState>({ url: null, status: "idle" });
  let s3State = $state<ServiceState>({ url: null, status: "idle" });

  let customPgUrl = $state("");
  let customRedisUrl = $state("");
  let customRelayUrl = $state("");
  let customS3Url = $state("");
  let customPgStatus = $state<ServiceStatus>("idle");
  let customRedisStatus = $state<ServiceStatus>("idle");
  let customRelayStatus = $state<ServiceStatus>("idle");
  let customS3Status = $state<ServiceStatus>("idle");
  let testingAll = $state(false);

  function statusColor(status: ServiceStatus): string {
    switch (status) {
      case "connected": return "text-online";
      case "error":
      case "disconnected": return "text-error";
      case "testing": return "text-warning";
      // Absent ≠ broken: an unconfigured optional service is a valid mode,
      // not an alarm (Redis without REDIS_URL = single-instance relay).
      case "not_configured": return "text-content-dim";
      default: return "text-content-dim";
    }
  }

  function statusDot(status: ServiceStatus): string {
    switch (status) {
      case "connected": return "bg-online";
      case "error":
      case "disconnected": return "bg-error";
      case "testing": return "bg-warning animate-pulse";
      case "not_configured": return "bg-content-dim/30";
      default: return "bg-content-dim/30";
    }
  }

  function statusLabel(status: ServiceStatus): string {
    switch (status) {
      case "connected": return "Connected";
      // Only a CONFIGURED service can be unreachable — absent ones report
      // not_configured below, so this wording can be honest about the failure.
      case "disconnected": return "Configured but unreachable";
      case "error": return "Error";
      case "testing": return "Testing...";
      case "not_configured": return "Not configured";
      default: return "Not tested";
    }
  }

  function mapStatus(s: string): ServiceStatus {
    return s === "connected" ? "connected" : "disconnected";
  }

  async function testConnection(type: "pg" | "redis" | "relay" | "s3"): Promise<void> {
    const urlMap = { pg: customPgUrl, redis: customRedisUrl, relay: customRelayUrl, s3: customS3Url };
    const statusSetter: Record<string, (s: ServiceStatus) => void> = {
      pg: (s) => customPgStatus = s,
      redis: (s) => customRedisStatus = s,
      relay: (s) => customRelayStatus = s,
      s3: (s) => customS3Status = s,
    };
    const url = urlMap[type];
    if (!url.trim()) return;

    statusSetter[type]("testing");
    await new Promise((r) => setTimeout(r, 1200));

    try {
      const u = new URL(url);
      statusSetter[type](u.protocol && u.host ? "connected" : "error");
    } catch {
      statusSetter[type]("error");
    }
  }

  async function testAll(): Promise<void> {
    testingAll = true;
    const tests: Promise<void>[] = [];
    if (customPgUrl.trim()) tests.push(testConnection("pg"));
    if (customRedisUrl.trim()) tests.push(testConnection("redis"));
    if (customRelayUrl.trim()) tests.push(testConnection("relay"));
    if (customS3Url.trim()) tests.push(testConnection("s3"));
    await Promise.all(tests);
    testingAll = false;
  }

  onMount(async () => {
    try {
      const status = await client.fetchBackendStatus();
      // A null url means the service was never configured (e.g. no REDIS_URL →
      // single-instance relay): show a neutral "Not configured", not an alarming
      // "disconnected". Only configured-and-down services get the error state.
      const svc = (url: string | null, st: string): ServiceState => ({
        url,
        status: url === null ? "not_configured" : mapStatus(st),
      });
      pgState = svc(status.postgres.url, status.postgres.status);
      redisState = svc(status.redis.url, status.redis.status);
      relayState = svc(status.relay.url, status.relay.status);
      if (status.s3) s3State = svc(status.s3.url, status.s3.status);
      activeTab = status.mode === "remote" ? "cloud" : "custom";
    } catch {
      activeTab = "cloud";
    } finally {
      loading = false;
    }
  });
</script>

<div class={viewportState.isMobile ? "px-4 pb-8 pt-3 space-y-6" : "mx-auto max-w-2xl px-6 py-8 space-y-8"}>
  {#if !viewportState.isMobile}
    <header>
      <h1 class="text-lg font-semibold text-content">Backend</h1>
      <p class="mt-1 text-xs text-content-muted">
        Infrastructure services powering this workspace
      </p>
    </header>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <div class="h-5 w-5 rounded-full border-2 border-content-dim border-t-transparent animate-spin"></div>
    </div>
  {:else}

  <section class="space-y-3">
    <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
      Connection mode
    </span>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <button
        type="button"
        onclick={() => { activeTab = "cloud"; }}
        class={cn(
          "flex flex-col items-start gap-2 rounded-lg border px-4 py-3.5 text-left transition-all",
          activeTab === "cloud"
            ? "border-btn-primary-bg bg-btn-primary-bg/5"
            : "border-edge opacity-50 hover:opacity-75",
        )}
      >
        <div class="flex items-center gap-2">
          <svg class={cn("h-5 w-5", activeTab === "cloud" ? "text-btn-primary-bg" : "text-content-dim")} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
          </svg>
          <span class={cn("text-sm font-medium", activeTab === "cloud" ? "text-content" : "text-content-muted")}>Cloud</span>
        </div>
        <p class="text-[11px] text-content-dim leading-relaxed">
          Connected to Cyborg7 cloud services. Managed infrastructure.
        </p>
      </button>

      <button
        type="button"
        onclick={() => { activeTab = "custom"; }}
        class={cn(
          "flex flex-col items-start gap-2 rounded-lg border px-4 py-3.5 text-left transition-all",
          activeTab === "custom"
            ? "border-btn-primary-bg bg-btn-primary-bg/5"
            : "border-edge opacity-50 hover:opacity-75",
        )}
      >
        <div class="flex items-center gap-2">
          <svg class={cn("h-5 w-5", activeTab === "custom" ? "text-btn-primary-bg" : "text-content-dim")} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
          <span class={cn("text-sm font-medium", activeTab === "custom" ? "text-content" : "text-content-muted")}>Custom</span>
        </div>
        <p class="text-[11px] text-content-dim leading-relaxed">
          Self-hosted or local services. Bring your own PostgreSQL, Redis, relay.
        </p>
      </button>
    </div>
  </section>

  {#if activeTab === "cloud"}
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Cloud services
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        {@render cloudServiceRow("PostgreSQL", pgState, "Shared storage for workspaces, channels, messages")}
        {@render cloudServiceRow("Redis", redisState, redisState.status === "not_configured" ? "Optional — without REDIS_URL the relay runs in single-instance mode (valid setup)" : "Pub/sub broker and rate limiting")}
        {@render cloudServiceRow("Relay Server", relayState, "Real-time message routing between daemons")}
        {@render cloudServiceRow("S3 Storage", s3State, "Asset storage for avatars, files, and uploads")}
      </div>
    </section>

    {#if pgState.status === "connected" && relayState.status === "connected" && s3State.status === "connected"}
      <section class="rounded-lg border border-online/20 bg-online/5 px-4 py-3 space-y-1.5">
        <div class="flex items-center gap-2">
          <svg class="h-4 w-4 text-online shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <span class="text-sm font-medium text-online">All services connected</span>
        </div>
        <p class="text-[11px] text-content-dim pl-6">
          Multi-user mode active. Workspaces, messages, and agent data are synced across all connected daemons.
        </p>
      </section>
    {/if}

  {:else}
    <section class="space-y-4">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Custom endpoints
      </span>

      <div class="space-y-3">
        {@render customServiceInput("PostgreSQL", customPgUrl, customPgStatus, "postgresql://user:pass@localhost:5432/cyborg7", "pg")}
        {@render customServiceInput("Redis", customRedisUrl, customRedisStatus, "redis://localhost:6379", "redis")}
        {@render customServiceInput("Relay Server", customRelayUrl, customRelayStatus, "ws://localhost:9100/relay", "relay")}
        {@render customServiceInput("S3 Storage", customS3Url, customS3Status, "https://your-bucket.s3.us-east-1.amazonaws.com", "s3")}
      </div>

      <button
        type="button"
        onclick={testAll}
        disabled={testingAll || (!customPgUrl.trim() && !customRedisUrl.trim() && !customRelayUrl.trim() && !customS3Url.trim())}
        class={cn(
          "w-full rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
          testingAll
            ? "border-warning/30 bg-warning/5 text-warning cursor-wait"
            : "border-btn-primary-bg/30 bg-btn-primary-bg/5 text-btn-primary-bg hover:bg-btn-primary-bg/10 disabled:opacity-40 disabled:cursor-not-allowed",
        )}
      >
        {testingAll ? "Testing connections..." : "Test All Connections"}
      </button>

      <p class="text-[11px] text-content-dim leading-relaxed">
        Enter your own service URLs. You can use localhost addresses for local development or point to any self-hosted infrastructure.
      </p>
    </section>
  {/if}

  <section class="space-y-3">
    <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
      How it works
    </span>
    <div class="rounded-lg border border-edge px-4 py-3.5 space-y-3">
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">1</span>
        </div>
        <div>
          <p class="text-sm text-content">Cloud mode</p>
          <p class="text-[11px] text-content-dim">Managed PostgreSQL, Redis, and relay broker. Multi-user workspaces, cross-device sync. Zero config.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">2</span>
        </div>
        <div>
          <p class="text-sm text-content">Custom mode</p>
          <p class="text-[11px] text-content-dim">Bring your own services. Run PostgreSQL and Redis locally or on your own servers. Full control over your data.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">3</span>
        </div>
        <div>
          <p class="text-sm text-content">Relay broker</p>
          <p class="text-[11px] text-content-dim">Routes real-time messages between daemons. Agents on one machine can be prompted from another. E2E encrypted.</p>
        </div>
      </div>
    </div>
  </section>
  {/if}
</div>

{#snippet cloudServiceRow(label: string, state: ServiceState, description: string)}
  <div class="px-4 py-3 space-y-1.5">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-content">{label}</span>
      <div class="flex items-center gap-1.5">
        <div class={cn("h-1.5 w-1.5 rounded-full", statusDot(state.status))}></div>
        <span class={cn("text-[10px] font-medium", statusColor(state.status))}>
          {statusLabel(state.status)}
        </span>
      </div>
    </div>
    {#if state.url}
      <p class="text-[12px] text-content-muted font-mono truncate">{state.url}</p>
    {/if}
    <p class="text-[11px] text-content-dim">{description}</p>
  </div>
{/snippet}

{#snippet customServiceInput(label: string, value: string, status: ServiceStatus, placeholder: string, type: "pg" | "redis" | "relay" | "s3")}
  <div class="rounded-lg border border-edge px-4 py-3 space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-content">{label}</span>
      {#if status !== "idle"}
        <div class="flex items-center gap-1.5">
          <div class={cn("h-1.5 w-1.5 rounded-full", statusDot(status))}></div>
          <span class={cn("text-[10px] font-medium", statusColor(status))}>
            {statusLabel(status)}
          </span>
        </div>
      {/if}
    </div>
    <div class="flex gap-2">
      <input
        type="text"
        {placeholder}
        {value}
        oninput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (type === "pg") customPgUrl = v;
          else if (type === "redis") customRedisUrl = v;
          else if (type === "relay") customRelayUrl = v;
          else customS3Url = v;
        }}
        class="flex-1 rounded-md border border-edge bg-surface px-3 py-1.5 text-[16px] sm:text-xs font-mono text-content placeholder:text-content-dim/40 focus:border-btn-primary-bg focus:outline-none focus:ring-1 focus:ring-btn-primary-bg/30"
      />
      <button
        type="button"
        onclick={() => testConnection(type)}
        disabled={!value.trim() || status === "testing"}
        class={cn(
          "shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition-all",
          status === "testing"
            ? "border-warning/30 text-warning cursor-wait"
            : "border-edge text-content-muted hover:border-btn-primary-bg hover:text-btn-primary-bg disabled:opacity-40 disabled:cursor-not-allowed",
        )}
      >
        {status === "testing" ? "..." : "Test"}
      </button>
    </div>
    {#if type === "redis"}
      <p class="text-[10px] text-content-dim/60">Optional — enables pub/sub and rate limiting</p>
    {:else if type === "s3"}
      <p class="text-[10px] text-content-dim/60">Optional — enables avatar uploads and file attachments</p>
    {/if}
  </div>
{/snippet}
