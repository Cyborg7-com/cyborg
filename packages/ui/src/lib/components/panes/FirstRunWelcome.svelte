<script lang="ts">
  import { goto } from "$app/navigation";
  import { agentsPaneState, fetchProjects, projectsCache } from "$lib/state/app.svelte.js";

  // ─── First-run "Get started" home (empty-workspace takeover) ─────────────────
  // A brand-new company lands here instead of the data-empty Home dashboard.
  // Cyborg7-flavored onboarding (NOT a generic PM checklist): it leans into what
  // makes us unique — humans + AI agents (cybos) collaborating across real
  // machines (daemons) in one shared stream. Three layers:
  //   1. SET UP  — the load-bearing steps, auto-detected from real state.
  //   2. LEARN   — dismissible tutorial cards (check → disappear), persisted.
  //   3. EXPLORE — quick links to our surfaces.
  // Plus a clear "Skip onboarding" → regular Home.
  //
  // Setup steps verified against this repo's routes/state:
  //   Connect a machine     → /daemons      ; done = daemonState.online > 0
  //   Bring an agent online  → /agent/new    ; done = agents.length > 0
  //   Invite humans          → /settings/members ; done = members.length > 1
  //   Start a project        → /tasks        ; done = a project exists

  let {
    workspaceId,
    workspaceName,
    userFirstName,
    hasDaemonOnline,
    hasAgents,
    hasTeammates,
    onDismiss,
  }: {
    workspaceId: string;
    workspaceName: string;
    userFirstName?: string | null;
    hasDaemonOnline: boolean;
    hasAgents: boolean;
    hasTeammates: boolean;
    onDismiss: () => void;
  } = $props();

  // ── Project step: no reactive global count, so seed from warm cache then fetch.
  let hasProject = $state(false);
  $effect(() => {
    const wsId = workspaceId;
    hasProject = (projectsCache.get(wsId)?.projects.length ?? 0) > 0;
    if (hasProject) return;
    let active = true;
    void fetchProjects()
      .then(({ projects }) => {
        if (!active) return;
        hasProject = projects.length > 0;
      })
      // intentional: best-effort "done" detection; the step just stays unchecked.
      .catch(() => {});
    return () => {
      active = false;
    };
  });

  const greeting = $derived(
    userFirstName ? `Welcome aboard, ${userFirstName} 👋` : `Welcome to ${workspaceName} 👋`,
  );

  // ── 1. Setup steps (auto-detected) ──────────────────────────────────────────
  interface Step {
    key: string;
    done: boolean;
    title: string;
    sub: string;
    cta: string;
    action: () => void;
    // Locked steps can't be started yet because they depend on an earlier one
    // (e.g. you can't create an agent until a machine is online — otherwise you
    // hit a dead "no providers detected" wall). Shown muted with a lock + hint.
    locked?: boolean;
    lockedHint?: string;
  }
  const steps = $derived<Step[]>([
    {
      key: "daemon",
      done: hasDaemonOnline,
      title: "Connect a machine",
      sub: "Bring a daemon online — the computer your agents run on.",
      cta: "Connect",
      action: () => {
        agentsPaneState.subTab = "daemon";
        void goto(`/workspace/${workspaceId}/daemons`);
      },
    },
    {
      key: "agent",
      done: hasAgents,
      title: "Create your first AI Employee",
      sub: "An AI agent (cybo) with its own name, role, personality and model — it joins your workspace and works alongside your team.",
      cta: "Create",
      action: () => void goto(`/workspace/${workspaceId}/agent/new`),
      locked: !hasDaemonOnline,
      lockedHint: "Connect a machine first",
    },
    {
      key: "team",
      done: hasTeammates,
      title: "Invite your humans",
      sub: "Add the people who'll collaborate with your agents in one shared stream.",
      cta: "Invite",
      action: () => void goto(`/workspace/${workspaceId}/settings/members`),
    },
    {
      key: "project",
      done: hasProject,
      title: "Start a project",
      sub: "Spin up a project so agents can pick up tasks, post updates and ship.",
      cta: "Open Tasks",
      action: () => void goto(`/workspace/${workspaceId}/tasks`),
    },
  ]);
  const completed = $derived(steps.filter((s) => s.done).length);
  const total = $derived(steps.length);
  const allDone = $derived(completed === total);
  const progress = $derived(Math.round((completed / total) * 100));
  // The next actionable step: first that's neither done nor locked. (A locked
  // step never becomes "next" — its blocker is highlighted instead.)
  const nextStep = $derived(steps.find((s) => !s.done && !s.locked) ?? null);

  // ── 2. Learn cards (click → video; × → dismiss; persisted per workspace) ─────
  // Placeholder video for every card for now — swap per-card `video` later.
  const PLACEHOLDER_VIDEO = "https://www.youtube.com/watch?v=PLk8Pm_XBJE";
  interface Learn {
    key: string;
    title: string;
    sub: string;
    icon: string;
    video: string;
  }
  const learnItems: Learn[] = [
    {
      key: "cybos",
      title: "Meet your cybos",
      sub: "AI teammates with their own personality, model and memory. DM one or drop it into any channel.",
      icon: `<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4.5M8.5 4.5h7M9 13h.01M15 13h.01"/>`,
      video: PLACEHOLDER_VIDEO,
    },
    {
      key: "daemons",
      title: "Agents run on real machines",
      sub: "Daemons let cybos execute on your team's computers — and securely request access to each other's.",
      icon: `<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>`,
      video: PLACEHOLDER_VIDEO,
    },
    {
      key: "stream",
      title: "Humans + agents, one stream",
      sub: "Channels where people and cybos work together in real time — every message shared with the team.",
      icon: `<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>`,
      video: PLACEHOLDER_VIDEO,
    },
    {
      key: "ship",
      title: "Let agents ship work",
      sub: "Create projects and work items; cybos pick them up, post updates and open pull requests.",
      icon: `<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="m8 12 3 3 5-6"/>`,
      video: PLACEHOLDER_VIDEO,
    },
  ];

  // Video lightbox: clicking a learn card opens its tutorial in an embedded
  // player. Accepts a YouTube watch/share URL and renders the privacy-friendly
  // nocookie embed.
  let videoUrl = $state<string | null>(null);
  function openVideo(url: string): void {
    videoUrl = url;
  }
  function closeVideo(): void {
    videoUrl = null;
  }
  function embedUrl(url: string): string {
    let id = "";
    try {
      const u = new URL(url);
      id = u.searchParams.get("v") ?? u.pathname.split("/").pop() ?? "";
    } catch {
      // intentional: a malformed URL falls back to an empty id (player shows nothing).
      id = "";
    }
    return id ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0` : url;
  }
  let dismissedLearn = $state<string[]>([]);
  // Watching a card's video marks it complete (a checkmark stays) — you've met
  // that intro. The × still removes a card entirely. Both persist per workspace.
  let watchedLearn = $state<string[]>([]);
  const learnKey = $derived(`cyborg7_onboarding_learn_${workspaceId}`);
  const watchedKey = $derived(`cyborg7_onboarding_watched_${workspaceId}`);
  $effect(() => {
    const dKey = learnKey;
    const wKey = watchedKey;
    try {
      dismissedLearn = JSON.parse(localStorage.getItem(dKey) ?? "[]") as string[];
      watchedLearn = JSON.parse(localStorage.getItem(wKey) ?? "[]") as string[];
    } catch {
      // intentional: missing/corrupt persisted state just shows all learn cards.
      dismissedLearn = [];
      watchedLearn = [];
    }
  });
  function dismissLearn(key: string): void {
    if (!dismissedLearn.includes(key)) dismissedLearn = [...dismissedLearn, key];
    try {
      localStorage.setItem(learnKey, JSON.stringify(dismissedLearn));
    } catch {
      // intentional: best-effort persistence; the card is already hidden in-session.
    }
  }
  // Open a card's tutorial AND mark it watched (checkmark).
  function watchLearn(item: Learn): void {
    if (!watchedLearn.includes(item.key)) {
      watchedLearn = [...watchedLearn, item.key];
      try {
        localStorage.setItem(watchedKey, JSON.stringify(watchedLearn));
      } catch {
        // intentional: best-effort persistence; the checkmark still shows in-session.
      }
    }
    openVideo(item.video);
  }
  const visibleLearn = $derived(learnItems.filter((l) => !dismissedLearn.includes(l.key)));
</script>

<div class="mx-auto flex w-full max-w-[720px] flex-col gap-9 px-6 py-10">
  <!-- Header + Skip -->
  <header class="flex items-start justify-between gap-4">
    <div>
      <p class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Get started</p>
      <h1 class="mt-1 text-[22px] font-bold leading-tight text-content">{greeting}</h1>
      <p class="mt-1 text-[13px] text-content-dim">
        {#if allDone}
          Your workspace is all set up. Explore below, or jump straight in.
        {:else}
          A few steps to get {workspaceName} running — then meet what makes Cyborg7 different.
        {/if}
      </p>
    </div>
    <button
      type="button"
      onclick={onDismiss}
      class="shrink-0 rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
    >
      Skip onboarding
    </button>
  </header>

  <!-- 1. Set up your workspace -->
  <section>
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-[12px] font-semibold uppercase tracking-wider text-content-muted">
        Set up your workspace
      </h2>
      <span class="text-[11px] font-semibold tabular-nums text-content-muted">{completed}/{total}</span>
    </div>
    <div class="mb-3 h-1 overflow-hidden rounded-full bg-surface-alt">
      <div
        class="h-full rounded-full bg-btn-primary-bg transition-[width] duration-500 ease-out"
        style="width: {progress}%"
      ></div>
    </div>

    <ol class="overflow-hidden rounded-xl border border-edge">
      {#each steps as step, i (step.key)}
        {@const isLocked = !step.done && !!step.locked}
        {@const isNext = !step.done && !isLocked && nextStep?.key === step.key}
        <li
          class="flex items-start gap-3.5 border-b border-edge px-4 py-3.5 last:border-b-0 {isNext
            ? 'bg-surface-alt'
            : ''} {isLocked ? 'opacity-60' : ''}"
        >
          <span
            class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold {step.done
              ? 'bg-online/15 text-online'
              : isNext
                ? 'bg-btn-primary-bg text-btn-primary-text'
                : 'bg-surface-alt text-content-muted'}"
          >
            {#if step.done}
              <svg class="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {:else if isLocked}
              <svg class="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="9" rx="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            {:else}
              {i + 1}
            {/if}
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[13.5px] font-semibold {step.done ? 'text-content-muted line-through decoration-content-muted/40' : 'text-content'}">
              {step.title}
            </p>
            <p class="mt-0.5 text-[12px] leading-snug text-content-muted">{step.sub}</p>
          </div>
          {#if step.done}
            <span class="shrink-0 text-[11px] font-medium text-online">Done</span>
          {:else if isLocked}
            <span class="shrink-0 whitespace-nowrap text-[11px] font-medium text-content-muted">{step.lockedHint}</span>
          {:else if isNext}
            <button
              type="button"
              onclick={step.action}
              class="shrink-0 rounded-md bg-btn-primary-bg px-2.5 py-1 text-[12px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
            >
              {step.cta}
            </button>
          {:else}
            <button
              type="button"
              onclick={step.action}
              aria-label={step.cta}
              class="flex size-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
            >
              <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          {/if}
        </li>
      {/each}
    </ol>
  </section>

  <!-- 2. Learn the basics (dismissible) -->
  {#if visibleLearn.length > 0}
    <section>
      <h2 class="mb-3 text-[12px] font-semibold uppercase tracking-wider text-content-muted">
        Learn the basics
      </h2>
      <div class="grid gap-2.5 sm:grid-cols-2">
        {#each visibleLearn as item (item.key)}
          {@const watched = watchedLearn.includes(item.key)}
          <div class="group relative rounded-xl border border-edge bg-[var(--card)] transition-colors hover:border-edge-light">
            <!-- Card body → opens the tutorial video -->
            <button
              type="button"
              onclick={() => watchLearn(item)}
              class="flex w-full gap-3 rounded-xl p-3.5 text-left transition-colors hover:bg-hover-gray"
            >
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-lg {watched
                  ? 'bg-online/15 text-online'
                  : 'bg-btn-primary-bg/10 text-btn-primary-bg'}"
                aria-hidden="true"
              >
                <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{@html item.icon}</svg>
              </span>
              <div class="min-w-0 flex-1 pr-5">
                <h3 class="flex items-center gap-1.5 text-[13.5px] font-semibold text-content">
                  {item.title}
                  {#if watched}
                    <svg class="size-3.5 shrink-0 text-online" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6" aria-label="Watched"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {:else}
                    <svg class="size-3.5 shrink-0 text-content-muted transition-colors group-hover:text-btn-primary-bg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                  {/if}
                </h3>
                <p class="mt-0.5 text-[12px] leading-snug text-content-muted">{item.sub}</p>
              </div>
            </button>
            <!-- × → dismiss the card (sibling of the body button, not nested) -->
            <button
              type="button"
              onclick={() => dismissLearn(item.key)}
              aria-label="Got it, dismiss"
              title="Got it"
              class="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
            >
              <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Footer -->
  <p class="text-center text-[11px] text-content-muted">
    Press <kbd class="rounded border border-edge px-1 font-sans">⌘</kbd>
    <kbd class="rounded border border-edge px-1 font-sans">/</kbd> anytime for keyboard shortcuts.
  </p>
</div>

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && videoUrl) closeVideo(); }} />

<!-- Tutorial video lightbox (Learn the basics). Scrim button closes; the player
     sits above it. -->
{#if videoUrl}
  <div class="fixed inset-0 z-50 bg-black/70">
    <button
      type="button"
      onclick={closeVideo}
      aria-label="Close video"
      class="absolute inset-0 h-full w-full cursor-default"
    ></button>
    <div class="absolute left-1/2 top-1/2 w-[min(900px,92vw)] -translate-x-1/2 -translate-y-1/2">
      <button
        type="button"
        onclick={closeVideo}
        aria-label="Close"
        class="absolute -top-9 right-0 flex size-7 items-center justify-center rounded-md border border-edge bg-surface text-content transition-colors hover:bg-hover-gray"
      >
        <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div class="aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl">
        <iframe
          class="h-full w-full"
          src={embedUrl(videoUrl)}
          title="Tutorial"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
      </div>
    </div>
  </div>
{/if}
