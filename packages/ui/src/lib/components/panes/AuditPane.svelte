<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";

  let { workspaceId = "" }: { workspaceId?: string } = $props();

  // ── Types ──
  type AuditStatus = "healthy" | "warning" | "critical";

  interface AgentAuditSummary {
    agentId: string;
    agentName: string;
    agentInitials: string;
    role: string;
    score: number | null;
    status: "healthy" | "warning" | "critical" | "unaudited";
    findingsCount: number;
    openRecsCount: number;
    lastAudit: string | null;
    trend: number[];
  }

  interface Finding {
    severity: string;
    title: string;
    description: string;
    criterion?: string;
    evidence?: string;
  }

  interface Recommendation {
    kind: string;
    text: string;
    effort: string;
    lift: string;
    reasoning: string;
    file?: string;
    currentContent?: string;
    proposedContent?: string;
    evidence?: string;
  }

  interface CriterionResult {
    criteriaName: string;
    score: number;
    weight?: number;
  }

  interface Criterion {
    id: string;
    name: string;
    prompt: string;
    weight: number;
    enabled: boolean;
    score?: number | null;
  }

  interface ReviewItem {
    agentName: string;
    agentInitials: string;
    type: "finding" | "recommendation";
    severity: string;
    title: string;
    kind?: string;
    rec?: Recommendation;
  }

  interface AuditRun {
    id: string;
    date: string;
    score: number | null;
    delta: number;
    findingsCount: number;
    recsApplied: number;
    recsPending: number;
    recsDismissed: number;
    notes?: string;
    isBaseline?: boolean;
  }

  // ── Helpers ──
  function scoreToStatus(score: number | null | undefined): AuditStatus {
    if (score == null) return "critical";
    if (score >= 85) return "healthy";
    if (score >= 70) return "warning";
    return "critical";
  }

  const STATUS_COLORS: Record<string, string> = {
    healthy: "var(--score-healthy)",
    warning: "var(--score-warning)",
    critical: "var(--score-critical)",
    unaudited: "var(--text-muted)",
  };

  const KIND_META: Record<string, { label: string; color: string; icon: string }> = {
    file_change: { label: "File change", color: "var(--color-link)", icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6" },
    action: { label: "Action", color: "var(--color-warning)", icon: "M7 2v11h3v9l7-12h-4l4-8z" },
    observation: { label: "Note", color: "var(--color-review)", icon: "M12 3l1.5 5L18 9.5 13.5 11 12 16l-1.5-5L6 9.5 10.5 8z" },
  };


  function sparkPoints(values: number[], w: number, h: number): string {
    if (values.length < 2) return "";
    const max = Math.max(...values, 100);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const step = w / (values.length - 1);
    return values.map((v, i) => `${i * step},${h - ((v - min) / range) * h}`).join(" ");
  }

  function getInitials(name: string): string {
    return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  }

  // ── Mock Data ──
  const mockAgents: AgentAuditSummary[] = [
    { agentId: "a1", agentName: "Lyra", agentInitials: "LY", role: "Content Writer", score: 92, status: "healthy", findingsCount: 1, openRecsCount: 2, lastAudit: "2h ago", trend: [78, 82, 85, 88, 90, 91, 92] },
    { agentId: "a2", agentName: "Orion", agentInitials: "OR", role: "Code Reviewer", score: 73, status: "warning", findingsCount: 4, openRecsCount: 5, lastAudit: "6h ago", trend: [65, 68, 71, 70, 72, 74, 73] },
    { agentId: "a3", agentName: "Nova", agentInitials: "NV", role: "Research Analyst", score: 58, status: "critical", findingsCount: 7, openRecsCount: 8, lastAudit: "1d ago", trend: [72, 68, 63, 61, 59, 57, 58] },
    { agentId: "a4", agentName: "Sage", agentInitials: "SG", role: "Data Analyst", score: 88, status: "healthy", findingsCount: 0, openRecsCount: 1, lastAudit: "3h ago", trend: [80, 83, 85, 86, 87, 88, 88] },
    { agentId: "a5", agentName: "Ember", agentInitials: "EM", role: "QA Tester", score: null, status: "unaudited", findingsCount: 0, openRecsCount: 0, lastAudit: null, trend: [] },
  ];

  const mockFindings: Finding[] = [
    { severity: "critical", title: "Hallucinated citation in research output", description: "Agent cited a non-existent paper in the quarterly report. The DOI resolves to a 404. This has happened twice in the last week.", criterion: "Accuracy", evidence: "Report v2.3, section 4.1 — DOI 10.1234/fake" },
    { severity: "high", title: "Inconsistent formatting in API docs", description: "Parameter descriptions alternate between sentence case and title case. Code examples use tabs instead of the project standard 2-space indent.", criterion: "Consistency" },
    { severity: "medium", title: "Slow response to priority-1 tickets", description: "Average response time for P1 tickets increased from 4 minutes to 12 minutes over the last 7 days.", criterion: "Responsiveness" },
    { severity: "high", title: "Missing error handling in generated code", description: "3 of 5 code reviews this week lacked try/catch blocks around async operations, violating the team's error handling policy.", criterion: "Code Quality" },
  ];

  const mockRecommendations: Recommendation[] = [
    { kind: "file_change", text: "Add citation verification step to research pipeline", effort: "low", lift: "high", reasoning: "Two hallucinated citations slipped through this week. Adding a DOI verification step before output would catch these automatically.", file: "agents/lyra/pipeline.yaml", currentContent: "steps:\n  - research\n  - draft\n  - review", proposedContent: "steps:\n  - research\n  - verify_citations\n  - draft\n  - review" },
    { kind: "action", text: "Create P1 response SLA alert for Orion", effort: "low", lift: "medium", reasoning: "P1 response times have drifted from 4min to 12min average. An alert at the 8-minute mark would catch delays before they compound." },
    { kind: "observation", text: "Sage's accuracy improved 8 points after prompt tuning", effort: "low", lift: "low", reasoning: "The prompt refinement applied two weeks ago has measurably improved output quality. Consider applying the same pattern to Nova's research prompts." },
    { kind: "file_change", text: "Enforce 2-space indent in code review template", effort: "medium", lift: "medium", reasoning: "Inconsistent indentation is the most common finding across code reviews. Updating the template would prevent this at the source.", file: "templates/code-review.md" },
  ];

  const mockCriteria: Criterion[] = [
    { id: "c1", name: "Accuracy", prompt: "Evaluate factual correctness, citation validity, and hallucination rate", weight: 30, enabled: true, score: 85 },
    { id: "c2", name: "Consistency", prompt: "Check formatting standards, naming conventions, and style guide adherence", weight: 20, enabled: true, score: 72 },
    { id: "c3", name: "Responsiveness", prompt: "Measure response times to tasks by priority level", weight: 15, enabled: true, score: 68 },
    { id: "c4", name: "Code Quality", prompt: "Assess error handling, test coverage, and adherence to coding standards", weight: 20, enabled: true, score: 78 },
    { id: "c5", name: "Communication", prompt: "Rate clarity, helpfulness, and tone of agent responses", weight: 15, enabled: true, score: 91 },
    { id: "c6", name: "Security", prompt: "Check for credential leaks, injection vulnerabilities, and unsafe patterns", weight: 0, enabled: false, score: null },
  ];

  const mockCriterionResults: CriterionResult[] = mockCriteria.filter(c => c.enabled && c.score != null).map(c => ({
    criteriaName: c.name,
    score: c.score!,
    weight: c.weight,
  }));

  const mockHistoryRuns: AuditRun[] = [
    { id: "r01", date: "May 24", score: 73, delta: 1, findingsCount: 4, recsApplied: 2, recsPending: 5, recsDismissed: 1, notes: "Minor improvements in consistency after template update." },
    { id: "r02", date: "May 23", score: 72, delta: -3, findingsCount: 5, recsApplied: 1, recsPending: 4, recsDismissed: 0, notes: "Response time regression detected." },
    { id: "r03", date: "May 22", score: 75, delta: 3, findingsCount: 3, recsApplied: 3, recsPending: 2, recsDismissed: 1 },
    { id: "r04", date: "May 21", score: 72, delta: 2, findingsCount: 4, recsApplied: 1, recsPending: 3, recsDismissed: 0, isBaseline: true },
    { id: "r05", date: "May 20", score: 70, delta: 0, findingsCount: 5, recsApplied: 0, recsPending: 5, recsDismissed: 0 },
  ];

  const mockReviewItems: ReviewItem[] = [
    { agentName: "Nova", agentInitials: "NV", type: "finding", severity: "critical", title: "Hallucinated citation in research output" },
    { agentName: "Orion", agentInitials: "OR", type: "finding", severity: "high", title: "Missing error handling in generated code" },
    { agentName: "Nova", agentInitials: "NV", type: "recommendation", severity: "medium", title: "Add citation verification step to research pipeline", kind: "file_change", rec: mockRecommendations[0] },
    { agentName: "Orion", agentInitials: "OR", type: "recommendation", severity: "medium", title: "Create P1 response SLA alert for Orion", kind: "action", rec: mockRecommendations[1] },
    { agentName: "Sage", agentInitials: "SG", type: "recommendation", severity: "medium", title: "Sage's accuracy improved 8 points after prompt tuning", kind: "observation", rec: mockRecommendations[2] },
  ];

  // ── State ──
  let selectedAgent = $state<string | null>(null);
  let agentTab = $state<"dash" | "history" | "findings" | "recs" | "settings">("dash");
  let fleetFilter = $state("all");
  let showRunAudit = $state(false);
  let runAuditStep = $state(0);
  let showRecDetail = $state(false);
  let activeRec = $state<Recommendation | null>(null);
  let showProviderSetup = $state(false);
  let toast = $state<string | null>(null);
  let scheduleMode = $state("nightly");
  let scheduleMenuOpen = $state(false);

  // ── Derived ──
  const selectedAgentData = $derived(mockAgents.find(a => a.agentId === selectedAgent));
  const needsAttention = $derived(mockAgents.filter(a => a.status !== "healthy" && a.status !== "unaudited").length);
  const avgScore = $derived(() => {
    const scored = mockAgents.filter(a => a.score != null);
    return scored.length > 0 ? Math.round(scored.reduce((s, a) => s + (a.score ?? 0), 0) / scored.length) : 0;
  });

  const filteredAgents = $derived.by(() => {
    if (fleetFilter === "needs_work") return mockAgents.filter(a => a.status === "warning" || a.status === "critical");
    if (fleetFilter === "healthy") return mockAgents.filter(a => a.status === "healthy");
    if (fleetFilter === "unaudited") return mockAgents.filter(a => a.status === "unaudited");
    return mockAgents;
  });

  const filterOptions = $derived([
    { id: "all", label: "All", count: mockAgents.length },
    { id: "needs_work", label: "Needs work", count: mockAgents.filter(a => a.status === "warning" || a.status === "critical").length },
    { id: "healthy", label: "Healthy", count: mockAgents.filter(a => a.status === "healthy").length },
    { id: "unaudited", label: "Unaudited", count: mockAgents.filter(a => a.status === "unaudited").length },
  ]);

  const totalWeight = $derived(mockCriteria.filter(c => c.enabled).reduce((s, c) => s + c.weight, 0));

  const agentTabs = $derived([
    { id: "dash", label: "Audit dashboard" },
    { id: "history", label: "History", count: mockHistoryRuns.length },
    { id: "findings", label: "Findings", count: mockFindings.length },
    { id: "recs", label: "Recommendations", count: mockRecommendations.length },
    { id: "settings", label: "Audit settings" },
  ]);

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => { toast = null; }, 3200);
  }

  function selectAgent(id: string) {
    selectedAgent = id;
    agentTab = "dash";
  }

  function backToFleet() {
    selectedAgent = null;
  }

  function openRecDetail(rec: Recommendation) {
    activeRec = rec;
    showRecDetail = true;
  }

  function closeRecDetail() {
    showRecDetail = false;
    activeRec = null;
  }
</script>

<div
  class="flex h-full flex-col text-content"
  style="background-color: var(--audit-page-bg); font-family: var(--font-inter), sans-serif;"
>
  {#if !selectedAgent}
    <!-- ═══════════════════════════════════════════════════════════════════ -->
    <!-- FLEET DASHBOARD                                                     -->
    <!-- ═══════════════════════════════════════════════════════════════════ -->
    <div class="flex-1 overflow-auto">
      <div class="mx-auto w-full max-w-[var(--content-max)] flex flex-col gap-5 px-6 py-5">
        <!-- Provider banner -->
        <div
          class="overflow-hidden rounded-xl border"
          style="border-color: color-mix(in srgb, var(--color-link) 30%, var(--border)); background-color: color-mix(in srgb, var(--color-link) 5%, var(--bg-surface));"
        >
          <div class="flex items-center gap-3 px-4 py-3">
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style="background-color: color-mix(in srgb, var(--color-link) 12%, transparent);"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-link)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <div class="flex-1">
              <span class="block text-[13px] font-medium text-white">No evaluation provider configured</span>
              <span class="text-[12px] text-content-dim">Set up an LLM provider to enable automatic audit scoring.</span>
            </div>
            <button
              type="button"
              onclick={() => { showProviderSetup = true; }}
              class="btn-primary flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              Set up provider
            </button>
          </div>
        </div>

        <!-- Hero: summary + schedule control -->
        <div class="flex items-start justify-between gap-6">
          <div>
            <h2 class="text-[22px] font-semibold text-white" style="letter-spacing: -0.01em;">
              {needsAttention} of {mockAgents.length} agents need review
            </h2>
            <p class="mt-1 text-[13px] text-content-dim">
              Last nightly run completed 2h ago · Fleet score <span class="font-medium tabular-nums text-white">{avgScore()}/100</span>
            </p>
          </div>

          <!-- Split button -->
          <div class="flex flex-col items-end gap-1.5">
            <div class="flex items-center gap-2.5">
              <div class="relative">
                <div class="inline-flex overflow-hidden rounded-lg" style="box-shadow: 0 1px 0 rgba(0,0,0,0.04);">
                  <button
                    type="button"
                    onclick={() => { showRunAudit = true; runAuditStep = 0; }}
                    class="btn-primary flex cursor-pointer items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-semibold"
                    style="border-radius: 0;"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
                    Run audit now
                  </button>
                  <button
                    type="button"
                    aria-label="Schedule options"
                    onclick={() => { scheduleMenuOpen = !scheduleMenuOpen; }}
                    class="btn-primary cursor-pointer px-2 py-1.5"
                    style="border-radius: 0; border-left: 1px solid color-mix(in srgb, var(--brand-contrast) 15%, transparent);"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                </div>
                {#if scheduleMenuOpen}
                  <div class="absolute right-0 top-full z-20 mt-1 w-[170px] rounded-lg border border-edge bg-surface-alt py-1 shadow-xl">
                    {#each [{ id: "nightly", label: "Nightly" }, { id: "weekly", label: "Weekly" }, { id: "bi-weekly", label: "Bi-weekly" }, { id: "off", label: "Off" }] as opt}
                      <button
                        type="button"
                        onclick={() => { scheduleMode = opt.id; scheduleMenuOpen = false; }}
                        class="w-full cursor-pointer px-3 py-2 text-left text-[12px] transition-colors hover:bg-edge {scheduleMode === opt.id ? 'font-medium text-white' : 'text-content-dim'}"
                      >
                        {#if scheduleMode === opt.id}<span class="mr-1.5">✓</span>{/if}
                        {opt.label}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1.5 text-[11px] text-content-muted">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                {#if scheduleMode === "nightly"}Nightly · next run tonight 03:00 UTC
                {:else if scheduleMode === "weekly"}Weekly · next run Sunday 03:00 UTC
                {:else if scheduleMode === "bi-weekly"}Bi-weekly · next run in 14 days
                {:else}No schedule set
                {/if}
              </span>
            </div>
          </div>
        </div>

        <!-- Review queue -->
        {#if mockReviewItems.length > 0}
          <div>
            <div class="mb-2.5 flex items-baseline justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Needs your attention</span>
              <span class="text-[12px] text-content-muted">Sorted by severity</span>
            </div>
            <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
              {#each mockReviewItems as item, i}
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-raised/50 {i < mockReviewItems.length - 1 ? 'border-b border-edge' : ''}"
                  onclick={() => {
                    if (item.rec) openRecDetail(item.rec);
                    else if (item.type === "finding") { selectAgent(mockAgents.find(a => a.agentName === item.agentName)?.agentId ?? ""); agentTab = "findings"; }
                  }}
                >
                  <!-- Avatar -->
                  <div
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                    style="background-color: color-mix(in srgb, var(--color-link) 20%, var(--bg-elevated));"
                  >
                    {item.agentInitials}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="mb-1 flex items-center gap-2">
                      <span class="text-[13px] font-semibold text-white">{item.agentName}</span>
                      <span class="text-[12px] text-content-muted">·</span>
                      {#if item.kind}
                        {@const meta = KIND_META[item.kind] ?? { label: item.kind, color: "var(--text-muted)", icon: "M12 12h.01" }}
                        <Badge
                          variant="tag"
                          style="color: {meta.color}; background-color: color-mix(in srgb, {meta.color} 10%, transparent); border-color: color-mix(in srgb, {meta.color} 25%, transparent);"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d={meta.icon} />
                          </svg>
                          {meta.label}
                        </Badge>
                      {:else}
                        <div class="flex items-center gap-1.5">
                          <span
                            class="inline-block h-2 w-2 shrink-0 rounded-sm"
                            style="background-color: {item.severity === 'critical' ? 'var(--color-error)' : item.severity === 'high' ? 'var(--color-warning)' : 'var(--text-muted)'};"
                          ></span>
                          <span class="text-[11px] capitalize text-content-dim">{item.severity} finding</span>
                        </div>
                      {/if}
                    </div>
                    <div class="truncate text-[13px] leading-snug text-content">{item.title}</div>
                  </div>
                  <div class="flex shrink-0 gap-1.5">
                    {#if item.kind === "file_change"}
                      <span class="btn-primary cursor-pointer rounded-lg px-3 py-1 text-[12px] font-medium" style="height: 28px; line-height: 28px;">Apply</span>
                    {:else if item.kind === "action"}
                      <span class="btn-primary cursor-pointer rounded-lg px-3 py-1 text-[12px] font-medium" style="height: 28px; line-height: 28px;">Create task</span>
                    {:else if item.kind === "observation"}
                      <span class="cursor-pointer rounded-lg border border-edge px-3 py-1 text-[12px] font-medium text-content-dim hover:text-white" style="height: 28px; line-height: 28px;">Acknowledge</span>
                    {:else}
                      <span class="cursor-pointer rounded-lg border border-edge px-3 py-1 text-[12px] font-medium text-content-dim hover:text-white" style="height: 28px; line-height: 28px;">Review</span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Agent table -->
        <div>
          <div class="mb-2.5 flex items-baseline justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">All agents</span>
            <div class="flex gap-1.5">
              {#each filterOptions as opt}
                <button
                  type="button"
                  onclick={() => { fleetFilter = opt.id; }}
                  class="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors {fleetFilter === opt.id ? 'bg-raised text-white' : 'text-content-muted hover:bg-surface-alt hover:text-content'}"
                >
                  {opt.label} {opt.count}
                </button>
              {/each}
            </div>
          </div>
          <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
            <!-- Header -->
            <div
              class="grid border-b border-edge px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-content-muted"
              style="grid-template-columns: 1.7fr 0.9fr 1.3fr 0.9fr 0.9fr 0.9fr 40px;"
            >
              <div>Agent</div>
              <div>Score</div>
              <div>7-day trend</div>
              <div>Findings</div>
              <div>Pending</div>
              <div>Last run</div>
              <div></div>
            </div>
            <!-- Rows -->
            {#each filteredAgents as agent, i}
              <button
                type="button"
                onclick={() => selectAgent(agent.agentId)}
                class="grid w-full cursor-pointer items-center px-4 py-3.5 text-left text-[13px] transition-colors hover:bg-raised/50 {i < filteredAgents.length - 1 ? 'border-b border-edge' : ''}"
                style="grid-template-columns: 1.7fr 0.9fr 1.3fr 0.9fr 0.9fr 0.9fr 40px;"
              >
                <div class="flex items-center gap-2.5">
                  <div
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
                    style="background-color: color-mix(in srgb, var(--color-link) 20%, var(--bg-elevated));"
                  >
                    {agent.agentInitials}
                  </div>
                  <div>
                    <div class="font-medium text-white">{agent.agentName}</div>
                    <div class="text-[11px] text-content-muted">{agent.role}</div>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="tabular-nums text-[18px] font-semibold" style="color: {STATUS_COLORS[agent.status]};">
                    {agent.score ?? "—"}
                  </span>
                  <span class="text-[11px] text-content-muted">/100</span>
                </div>
                <div style="color: {STATUS_COLORS[agent.status]};">
                  {#if agent.trend.length >= 2}
                    <svg width="110" height="24" viewBox="0 0 110 24" class="block">
                      <polyline fill="none" stroke={STATUS_COLORS[agent.status]} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points={sparkPoints(agent.trend, 110, 24)} />
                    </svg>
                  {:else}
                    <span class="text-[11px] text-content-muted">No data</span>
                  {/if}
                </div>
                <div class="tabular-nums {agent.findingsCount > 0 ? 'text-content' : 'text-content-muted'}">
                  {agent.findingsCount}
                </div>
                <div class="tabular-nums {agent.openRecsCount > 0 ? 'text-content' : 'text-content-muted'}">
                  {agent.openRecsCount}
                </div>
                <div class="text-content-dim">{agent.lastAudit ?? "Never"}</div>
                <div class="text-content-muted">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </div>
              </button>
            {/each}
            {#if filteredAgents.length === 0}
              <div class="px-4 py-8 text-center text-[13px] text-content-muted">No agents match this filter</div>
            {/if}
          </div>
        </div>
      </div>
    </div>

  {:else}
    <!-- ═══════════════════════════════════════════════════════════════════ -->
    <!-- PER-AGENT VIEW                                                      -->
    <!-- ═══════════════════════════════════════════════════════════════════ -->

    <!-- Agent header -->
    <div class="flex shrink-0 items-center gap-3 border-b border-edge px-6 py-3">
      <button type="button" aria-label="Back to fleet" onclick={backToFleet} class="cursor-pointer p-1 text-content-muted hover:text-white">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
      </button>
      <span class="text-[15px] font-semibold text-white">{selectedAgentData?.agentName ?? "Agent"}</span>
      <div class="flex-1"></div>
      <span class="font-mono text-[11px] text-content-muted">
        {selectedAgentData?.lastAudit ? `audited ${selectedAgentData.lastAudit}` : "never audited"}
      </span>
      <button
        type="button"
        onclick={() => { showRunAudit = true; runAuditStep = 0; }}
        class="btn-primary flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
        Run audit now
      </button>
    </div>

    <!-- Tab bar -->
    <div class="flex shrink-0 gap-0 border-b border-edge px-6">
      {#each agentTabs as tab}
        <button
          type="button"
          onclick={() => { agentTab = tab.id as typeof agentTab; }}
          class="mr-6 cursor-pointer border-b-2 py-3 text-[13px] font-medium transition-colors {agentTab === tab.id ? 'border-white text-white' : 'border-transparent text-content-dim hover:text-content'}"
        >
          {tab.label}
          {#if tab.count != null}
            <span class="ml-1.5 text-content-muted">{tab.count}</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-auto">

      <!-- ═══ Dashboard tab ═══ -->
      {#if agentTab === "dash"}
        {#if selectedAgentData?.status === "unaudited"}
          <!-- Empty state for unaudited agent -->
          <div class="flex min-h-[480px] flex-1 items-center justify-center px-6 py-16">
            <div class="max-w-md text-center">
              <div class="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center">
                <span class="absolute inset-0 animate-ping rounded-full" style="background-color: color-mix(in srgb, var(--color-link) 18%, transparent);"></span>
                <span class="relative flex h-16 w-16 items-center justify-center rounded-full" style="background-color: color-mix(in srgb, var(--color-link) 12%, var(--bg-surface)); border: 1px solid color-mix(in srgb, var(--color-link) 35%, var(--border));">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-link)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
                    <line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" />
                  </svg>
                </span>
              </div>
              <span class="text-[10px] font-semibold uppercase tracking-wider text-content-muted">Unaudited</span>
              <h2 class="mt-2 text-[20px] font-semibold text-white" style="letter-spacing: -0.01em;">
                {selectedAgentData.agentName} hasn't been audited yet
              </h2>
              <p class="mt-2 text-[13px] leading-relaxed text-content-dim">
                Run an audit to score this agent's quality, surface findings, and get tailored recommendations to help them improve.
              </p>
              <div class="mt-6 flex justify-center">
                <button
                  type="button"
                  onclick={() => { showRunAudit = true; runAuditStep = 0; }}
                  class="btn-primary inline-flex cursor-pointer items-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
                  Run audit now
                </button>
              </div>
            </div>
          </div>
        {:else}
          {@const status = scoreToStatus(selectedAgentData?.score)}
          {@const color = STATUS_COLORS[status]}
          {@const statusLabel = status === "healthy" ? "Healthy" : status === "warning" ? "At risk" : "Critical"}
          <!-- Agent Dashboard -->
          <div class="mx-auto max-w-[var(--content-max)] flex flex-col gap-5 p-6">
            <!-- Score hero -->
            <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
              <div class="grid" style="grid-template-columns: 280px 1fr;">
                <!-- Left: score + trend -->
                <div class="border-r border-edge p-6" style="background: linear-gradient(180deg, color-mix(in srgb, {color} 8%, transparent), transparent);">
                  <span class="mb-2.5 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Current score</span>
                  <div class="flex items-baseline gap-2">
                    <span class="font-bold tabular-nums leading-none" style="color: {color}; font-size: 64px; letter-spacing: -0.02em;">
                      {selectedAgentData?.score ?? "—"}
                    </span>
                    <span class="text-[18px] text-content-muted">/100</span>
                  </div>
                  <div class="mt-2 flex items-center gap-2">
                    <Badge
                      variant="tag"
                      style="color: {color}; background-color: color-mix(in srgb, {color} 10%, transparent); border-color: color-mix(in srgb, {color} 25%, transparent);"
                    >
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {color};"></span>
                      {selectedAgentData?.score ?? 0}
                    </Badge>
                    <span class="text-[11px] text-content-muted">{statusLabel}</span>
                  </div>
                  {#if selectedAgentData && selectedAgentData.trend.length >= 2}
                    <div class="mt-4">
                      <svg width="232" height="44" viewBox="0 0 232 44" class="block">
                        <polyline fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points={sparkPoints(selectedAgentData.trend, 232, 44)} />
                      </svg>
                    </div>
                  {/if}
                </div>
                <!-- Right: criterion breakdown -->
                <div class="p-6">
                  <div class="mb-3.5 flex items-baseline justify-between">
                    <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Score breakdown by criterion</span>
                    <span class="text-[11px] text-content-muted">{mockCriterionResults.length} active criteria</span>
                  </div>
                  <div class="grid grid-cols-2 gap-3.5">
                    {#each mockCriterionResults as c}
                      {@const cStatus = scoreToStatus(c.score)}
                      {@const cColor = STATUS_COLORS[cStatus]}
                      <div>
                        <div class="mb-1 flex items-baseline justify-between">
                          <span class="text-[12px] font-medium text-content">{c.criteriaName}</span>
                          <span class="flex items-baseline gap-1.5">
                            <span class="tabular-nums text-[14px] font-semibold" style="color: {cColor};">{c.score}</span>
                            {#if c.weight != null}
                              <span class="text-[10px] text-content-muted">wt {c.weight}%</span>
                            {/if}
                          </span>
                        </div>
                        <div class="h-1 overflow-hidden rounded-full bg-edge">
                          <div class="h-full rounded-full transition-all" style="width: {Math.min(100, Math.max(0, c.score))}%; background-color: {cColor};"></div>
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            </div>

            <!-- Findings + Recommendations -->
            <div class="grid grid-cols-2 gap-4">
              <!-- Findings -->
              <div>
                <div class="mb-2.5 flex items-baseline justify-between">
                  <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Findings · {mockFindings.length} open</span>
                </div>
                <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
                  {#each mockFindings as f, i}
                    <div class="p-3.5 {i < mockFindings.length - 1 ? 'border-b border-edge' : ''}">
                      <div class="mb-1.5 flex items-center gap-2">
                        <span
                          class="inline-block h-2 w-2 shrink-0 rounded-sm"
                          style="background-color: {f.severity === 'critical' ? 'var(--color-error)' : f.severity === 'high' ? 'var(--color-warning)' : f.severity === 'info' ? 'var(--color-link)' : 'var(--text-secondary)'};"
                        ></span>
                        <span
                          class="text-[11px] font-medium uppercase tracking-wider"
                          style="color: {f.severity === 'critical' ? 'var(--color-error)' : f.severity === 'high' ? 'var(--color-warning)' : 'var(--text-secondary)'};"
                        >{f.severity}</span>
                        {#if f.criterion}
                          <span class="text-[11px] text-content-muted">·</span>
                          <span class="text-[11px] text-content-muted">{f.criterion}</span>
                        {/if}
                      </div>
                      <div class="mb-1 text-[13px] font-medium text-white">{f.title}</div>
                      <div class="mb-1.5 text-[12px] leading-relaxed text-content-dim">{f.description}</div>
                      {#if f.evidence}
                        <div class="font-mono text-[11px] text-content-muted">{f.evidence}</div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>

              <!-- Recommendations -->
              <div>
                <div class="mb-2.5 flex items-baseline justify-between">
                  <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Recommendations · {mockRecommendations.length} pending</span>
                </div>
                <div class="flex flex-col gap-2.5">
                  {#each mockRecommendations as r}
                    {@const meta = KIND_META[r.kind] ?? { label: r.kind, color: "var(--text-muted)", icon: "M12 12h.01" }}
                    <div class="rounded-xl border border-edge p-3.5 bg-surface-alt">
                      <div class="mb-2 flex items-center gap-2">
                        <Badge
                          variant="tag"
                          style="color: {meta.color}; background-color: color-mix(in srgb, {meta.color} 10%, transparent); border-color: color-mix(in srgb, {meta.color} 25%, transparent);"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d={meta.icon} />
                          </svg>
                          {meta.label}
                        </Badge>
                        <span class="text-[11px] text-content-muted">{r.effort} effort · {r.lift} lift</span>
                      </div>
                      <div class="mb-1 text-[13px] font-medium text-white">{r.text}</div>
                      <div class="mb-2.5 text-[12px] leading-relaxed text-content-dim">{r.reasoning}</div>
                      {#if r.file}
                        <div class="mb-2.5 font-mono text-[11px] text-content-muted">{r.file}</div>
                      {/if}
                      <div class="flex gap-1.5">
                        {#if r.kind === "file_change"}
                          <button type="button" onclick={() => showToast("Change applied")} class="btn-primary flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                            Apply
                          </button>
                        {:else if r.kind === "action"}
                          <button type="button" onclick={() => showToast("Task created")} class="btn-primary cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium">Create task</button>
                        {:else if r.kind === "observation"}
                          <button type="button" onclick={() => showToast("Acknowledged")} class="cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-[12px] font-medium text-content-dim transition-colors hover:text-white">Acknowledge</button>
                        {/if}
                        <button type="button" onclick={() => openRecDetail(r)} class="cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-[12px] font-medium text-content-muted transition-colors hover:text-content">Details</button>
                        <button type="button" onclick={() => showToast("Dismissed")} class="cursor-pointer px-3 py-1.5 text-[12px] font-medium text-content-muted transition-colors hover:text-content">Dismiss</button>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        {/if}

      <!-- ═══ History tab ═══ -->
      {:else if agentTab === "history"}
        <div class="mx-auto max-w-[var(--content-max)] grid gap-6 p-6" style="grid-template-columns: 1fr 320px;">
          <!-- Left: timeline -->
          <div>
            <span class="mb-3.5 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Run history</span>

            <!-- Score chart -->
            {#if mockHistoryRuns.length > 1}
              {@const scores = mockHistoryRuns.filter(r => r.score != null).map(r => r.score!)}
              <div class="mb-5 rounded-xl border border-edge p-4 bg-surface-alt">
                <div class="mb-2.5 flex items-baseline justify-between">
                  <div>
                    <div class="text-[13px] font-medium text-white">Score over time</div>
                    <div class="text-[11px] text-content-muted">{mockHistoryRuns.length} runs</div>
                  </div>
                </div>
                <svg width="100%" height="90" viewBox="0 0 600 90" preserveAspectRatio="none">
                  <line x1="0" y1={90 - (85 / 100) * 80} x2="600" y2={90 - (85 / 100) * 80} stroke="color-mix(in srgb, var(--score-healthy) 25%, transparent)" stroke-dasharray="3 4" />
                  <text x="598" y={90 - (85 / 100) * 80 - 4} font-size="9" fill="var(--score-healthy)" text-anchor="end">healthy 85</text>
                  <polyline
                    fill="none"
                    stroke={STATUS_COLORS[scoreToStatus(scores[scores.length - 1])]}
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    points={scores.map((s, i) => `${(i / (scores.length - 1)) * 560 + 20},${90 - (s / 100) * 80}`).join(" ")}
                  />
                  {#each scores as s, i}
                    {@const x = (i / (scores.length - 1)) * 560 + 20}
                    {@const y = 90 - (s / 100) * 80}
                    <circle cx={x} cy={y} r="4" fill={STATUS_COLORS[scoreToStatus(s)]} />
                    <text x={x} y={y - 8} font-size="10" fill="var(--text-strong, #fff)" text-anchor="middle" font-weight="500">{s}</text>
                  {/each}
                </svg>
              </div>
            {/if}

            <!-- Timeline entries -->
            <div class="relative pl-5">
              <div class="absolute left-[5px] top-2 bottom-2 w-px bg-edge"></div>
              {#each mockHistoryRuns as run}
                <div class="relative mb-3.5">
                  <div
                    class="absolute -left-5 top-4 h-[11px] w-[11px] rounded-full border-2"
                    style="background-color: {run.isBaseline ? 'var(--color-review)' : STATUS_COLORS[scoreToStatus(run.score)]}; border-color: var(--bg-base);"
                  ></div>
                  <div class="rounded-xl border border-edge p-3.5 transition-colors hover:bg-raised/30 bg-surface-alt">
                    <div class="mb-2 flex items-center gap-2.5">
                      <span class="font-mono text-[12px] font-medium text-white">Run #{run.id.slice(1)}</span>
                      <span class="text-[12px] text-content-dim">{run.date}</span>
                      {#if run.isBaseline}
                        <Badge
                          variant="tag"
                          style="color: var(--color-review); background-color: color-mix(in srgb, var(--color-review) 10%, transparent); border-color: color-mix(in srgb, var(--color-review) 25%, transparent);"
                        >baseline</Badge>
                      {/if}
                      <div class="flex-1"></div>
                      <div class="flex items-baseline gap-1.5">
                        <span class="tabular-nums text-[20px] font-semibold" style="color: {STATUS_COLORS[scoreToStatus(run.score)]};">
                          {run.score ?? "—"}
                        </span>
                        {#if run.delta !== 0}
                          <span class="font-mono text-[11px]" style="color: {run.delta > 0 ? 'var(--score-healthy)' : 'var(--score-critical)'};">
                            {run.delta > 0 ? "+" : ""}{run.delta}
                          </span>
                        {/if}
                      </div>
                    </div>
                    <div class="mb-1 flex gap-4 text-[12px] text-content-dim">
                      <span><span class="tabular-nums font-medium text-white">{run.findingsCount}</span> finding{run.findingsCount !== 1 ? "s" : ""}</span>
                      <span class="text-online"><span class="tabular-nums font-medium">{run.recsApplied}</span> applied</span>
                      {#if run.recsPending > 0}
                        <span class="text-warning"><span class="tabular-nums font-medium">{run.recsPending}</span> pending</span>
                      {/if}
                      {#if run.recsDismissed > 0}
                        <span class="text-content-muted"><span class="tabular-nums font-medium">{run.recsDismissed}</span> dismissed</span>
                      {/if}
                    </div>
                    {#if run.notes}
                      <p class="text-[12px] leading-relaxed text-content-muted">{run.notes}</p>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>

          <!-- Right rail: stats -->
          <div class="flex flex-col gap-4">
            <div class="rounded-xl border border-edge p-4 bg-surface-alt">
              <span class="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Lifetime stats</span>
              <div class="space-y-3">
                {#each [
                  { label: "Total audits", value: mockHistoryRuns.length },
                  { label: "Average score", value: Math.round(mockHistoryRuns.reduce((s, r) => s + (r.score ?? 0), 0) / mockHistoryRuns.length) },
                  { label: "Best score", value: Math.max(...mockHistoryRuns.map(r => r.score ?? 0)) },
                  { label: "Total findings", value: mockHistoryRuns.reduce((s, r) => s + r.findingsCount, 0) },
                  { label: "Recs applied", value: mockHistoryRuns.reduce((s, r) => s + r.recsApplied, 0) },
                ] as stat}
                  <div class="flex items-center justify-between">
                    <span class="text-[12px] text-content-dim">{stat.label}</span>
                    <span class="tabular-nums text-[13px] font-medium text-white">{stat.value}</span>
                  </div>
                {/each}
              </div>
            </div>
            <div class="rounded-xl border border-edge p-4 bg-surface-alt">
              <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Compare runs</span>
              <p class="mb-3 text-[12px] text-content-muted">Select two runs to see a side-by-side diff of scores, findings, and recommendations.</p>
              <button type="button" class="w-full cursor-pointer rounded-lg border border-edge py-2 text-center text-[12px] font-medium text-content-dim hover:text-white">
                Pick first run
              </button>
            </div>
          </div>
        </div>

      <!-- ═══ Findings tab ═══ -->
      {:else if agentTab === "findings"}
        <div class="mx-auto max-w-[var(--content-max)] p-6">
          <span class="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">All findings · {mockFindings.length}</span>
          <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
            {#if mockFindings.length === 0}
              <div class="px-4 py-8 text-center text-[13px] text-content-muted">No findings</div>
            {:else}
              {#each mockFindings as f, i}
                <div class="p-4 {i < mockFindings.length - 1 ? 'border-b border-edge' : ''}">
                  <div class="mb-1.5 flex items-center gap-2">
                    <span
                      class="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style="background-color: {f.severity === 'critical' || f.severity === 'high' ? 'var(--color-error)' : 'var(--color-warning)'};"
                    ></span>
                    <span class="text-[11px] font-medium uppercase tracking-wider text-content-dim">{f.severity}</span>
                  </div>
                  <div class="mb-1 text-[13px] font-medium text-white">{f.title}</div>
                  <div class="text-[12px] leading-relaxed text-content-dim">{f.description}</div>
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ Recommendations tab ═══ -->
      {:else if agentTab === "recs"}
        <div class="mx-auto max-w-[var(--content-max)] p-6">
          <span class="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">All recommendations · {mockRecommendations.length}</span>
          <div class="flex flex-col gap-2.5">
            {#if mockRecommendations.length === 0}
              <div class="rounded-xl border border-edge px-4 py-8 text-center text-[13px] text-content-muted bg-surface-alt">
                No pending recommendations
              </div>
            {:else}
              {#each mockRecommendations as r}
                <div class="rounded-xl border border-edge p-4 bg-surface-alt">
                  <div class="mb-1 text-[13px] font-medium text-white">{r.text}</div>
                  <div class="mb-2 text-[12px] leading-relaxed text-content-dim">{r.reasoning}</div>
                  <div class="flex gap-1.5">
                    <button type="button" onclick={() => openRecDetail(r)} class="cursor-pointer rounded-lg border border-edge px-3 py-1 text-[12px] font-medium text-content-dim hover:text-white">Details</button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>

      <!-- ═══ Settings tab ═══ -->
      {:else if agentTab === "settings"}
        <div class="mx-auto max-w-[var(--content-max)] grid gap-6 p-6" style="grid-template-columns: 1fr 300px;">
          <!-- Left: schedule + criteria table -->
          <div>
            <!-- Schedule -->
            <div class="mb-6">
              <span class="mb-2.5 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Schedule</span>
              <div class="rounded-xl border border-edge p-4 bg-surface-alt">
                <div class="mb-3 flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="Toggle automatic audits"
                    class="relative h-[18px] w-8 shrink-0 rounded-full transition-colors bg-content"
                  >
                    <span class="absolute top-[2px] left-[14px] h-[14px] w-[14px] rounded-full bg-teal-contrast transition-transform"></span>
                  </button>
                  <div class="flex-1">
                    <div class="text-[13px] font-medium text-white">Automatic audits</div>
                    <div class="text-[12px] text-content-dim">Next run: tonight at 03:00 UTC</div>
                  </div>
                </div>
                <div class="flex gap-2">
                  {#each ["Nightly", "Weekly", "Bi-weekly", "Monthly"] as freq}
                    <button
                      type="button"
                      class="cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors {freq.toLowerCase() === 'nightly' ? 'bg-raised text-white' : 'text-content-muted hover:text-content hover:bg-surface-alt'}"
                    >
                      {freq}
                    </button>
                  {/each}
                </div>
              </div>
            </div>

            <!-- Criteria table -->
            <div class="mb-2.5 flex items-baseline justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Evaluation criteria</span>
              <div class="flex items-center gap-2.5 text-[12px]">
                <span class="text-content-muted">Weights sum to</span>
                <span class="tabular-nums font-semibold {totalWeight === 100 ? 'text-online' : 'text-warning'}">{totalWeight}%</span>
              </div>
            </div>
            <div class="overflow-hidden rounded-xl border border-edge bg-surface-alt">
              <!-- Header -->
              <div
                class="grid border-b border-edge bg-deeper px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-content-muted"
                style="grid-template-columns: 40px 1fr 90px 90px 28px;"
              >
                <div></div>
                <div>Criterion</div>
                <div>Weight</div>
                <div>Last score</div>
                <div></div>
              </div>
              {#each mockCriteria as c, i}
                <div
                  class="grid items-center px-4 py-3.5 {i < mockCriteria.length - 1 ? 'border-b border-edge' : ''}"
                  style="grid-template-columns: 40px 1fr 90px 90px 28px; gap: 12px; opacity: {c.enabled ? 1 : 0.55};"
                >
                  <button
                    type="button"
                    aria-label={`Toggle ${c.name}`}
                    class="relative h-[18px] w-8 shrink-0 rounded-full transition-colors {c.enabled ? 'bg-content' : 'bg-edge'}"
                  >
                    <span class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-teal-contrast transition-transform {c.enabled ? 'left-[14px]' : 'left-[2px]'}"></span>
                  </button>
                  <div>
                    <div class="mb-0.5 text-[13px] font-medium text-white">{c.name}</div>
                    <div class="text-[12px] leading-snug text-content-dim">{c.prompt}</div>
                  </div>
                  <div>
                    <input
                      type="number"
                      value={c.weight}
                      disabled={!c.enabled}
                      class="w-16 rounded-md border border-edge bg-surface-alt px-2 py-1 tabular-nums text-[12px] text-white focus:border-edge-light focus:outline-none disabled:opacity-40"
                      min="0"
                      max="100"
                    />
                  </div>
                  <div>
                    {#if c.score != null}
                      {@const cColor = STATUS_COLORS[scoreToStatus(c.score)]}
                      <Badge
                        variant="tag"
                        style="color: {cColor}; background-color: color-mix(in srgb, {cColor} 10%, transparent); border-color: color-mix(in srgb, {cColor} 25%, transparent);"
                      >
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {cColor};"></span>
                        {c.score}
                      </Badge>
                    {:else}
                      <span class="text-[12px] text-content-muted">—</span>
                    {/if}
                  </div>
                  <button type="button" aria-label="Criterion options" class="cursor-pointer p-1 text-content-muted hover:text-content">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 13a1 1 0 100-2 1 1 0 000 2zM19 13a1 1 0 100-2 1 1 0 000 2zM5 13a1 1 0 100-2 1 1 0 000 2z" />
                    </svg>
                  </button>
                </div>
              {/each}
              <!-- Add row -->
              <button type="button" class="flex w-full cursor-pointer items-center gap-2 border-t border-edge px-4 py-3 text-[13px] text-content-muted transition-colors hover:bg-raised/30 hover:text-content">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add custom criterion
              </button>
            </div>
          </div>

          <!-- Right rail -->
          <div class="flex flex-col gap-4">
            <div class="rounded-xl border border-edge p-4 bg-surface-alt">
              <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Criteria lineage</span>
              <p class="mb-3 text-[12px] leading-relaxed text-content-dim">
                {mockCriteria.length} criteria active. Weights are per-agent and can diverge from workspace defaults.
              </p>
              <button type="button" class="w-full cursor-pointer rounded-lg border border-edge py-2 text-center text-[12px] font-medium text-content-dim hover:text-white">
                View change history
              </button>
            </div>
            <div class="rounded-xl border border-edge p-4 bg-surface-alt">
              <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Inherit from workspace</span>
              <p class="mb-3 text-[12px] leading-relaxed text-content-dim">
                Reset this agent's criteria to match workspace defaults. Custom weights will be overwritten.
              </p>
              <button type="button" class="w-full cursor-pointer rounded-lg border border-edge py-2 text-center text-[12px] font-medium text-content-dim hover:text-white">
                Reset to defaults
              </button>
            </div>
            <div class="rounded-xl border p-4 bg-surface-alt" style="border-color: color-mix(in srgb, var(--color-error) 30%, var(--border));">
              <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-error">Danger zone</span>
              <p class="mb-3 text-[12px] leading-relaxed text-content-dim">
                Pausing audits stops all scheduled runs for this agent. Existing results are preserved.
              </p>
              <button type="button" class="w-full cursor-pointer rounded-lg border py-2 text-center text-[12px] font-medium text-error" style="border-color: color-mix(in srgb, var(--color-error) 40%, transparent);">
                Pause audits
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!-- RUN AUDIT MODAL                                                     -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  {#if showRunAudit}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-6"
      onclick={() => { showRunAudit = false; }}
      style="background: color-mix(in srgb, var(--background) 72%, transparent); backdrop-filter: blur(4px);"
      role="dialog"
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="relative flex w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-edge bg-surface-alt"
        style="max-height: 85vh; box-shadow: 0 24px 60px rgba(0,0,0,0.4);"
        onclick={(e) => e.stopPropagation()}
      >
        <!-- Header -->
        <div class="shrink-0 border-b border-edge px-6 pt-5 pb-4">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-[18px] font-semibold text-white" style="letter-spacing: -0.01em;">Run a new audit</h3>
            <button type="button" aria-label="Close" onclick={() => { showRunAudit = false; }} class="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-raised hover:text-white">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <!-- Stepper -->
          <div class="flex gap-2">
            {#each ["Agents", "Criteria", "Window", "Review"] as step, i}
              <div class="flex-1">
                <div class="mb-2 h-1 rounded-full transition-colors {i <= runAuditStep ? 'bg-teal' : 'bg-edge'}"></div>
                <span class="text-[11px] font-medium {i === runAuditStep ? 'text-white' : i < runAuditStep ? 'text-content-dim' : 'text-content-muted'}">
                  {i + 1}. {step}
                </span>
              </div>
            {/each}
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-auto px-6 py-5">
          {#if runAuditStep === 0}
            <p class="mb-4 text-[13px] leading-relaxed text-content-dim">Select which agents to include in this audit run.</p>
            <div class="divide-y divide-edge overflow-hidden rounded-lg border border-edge">
              {#each mockAgents as agent}
                <div class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raised/30">
                  <div class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-[1.5px] border-edge-light bg-accent">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </div>
                  <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-bold text-white" style="background-color: color-mix(in srgb, var(--color-link) 20%, var(--bg-elevated));">
                    {agent.agentInitials}
                  </div>
                  <span class="flex-1 text-[13px] font-medium text-white">{agent.agentName}</span>
                  {#if agent.score != null}
                    {@const sc = STATUS_COLORS[scoreToStatus(agent.score)]}
                    <Badge variant="tag" style="color: {sc}; background-color: color-mix(in srgb, {sc} 10%, transparent); border-color: color-mix(in srgb, {sc} 25%, transparent);">
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" style="background-color: {sc};"></span>
                      {agent.score}
                    </Badge>
                  {/if}
                </div>
              {/each}
            </div>
          {:else if runAuditStep === 1}
            <p class="mb-4 text-[13px] leading-relaxed text-content-dim">Pick the criteria to evaluate agents against.</p>
            <div class="grid grid-cols-2 gap-2">
              {#each mockCriteria as c}
                <button type="button" class="flex cursor-pointer items-center gap-2.5 rounded-lg border border-edge-light bg-raised/40 px-3 py-2.5 text-left transition-all">
                  <div class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-[1.5px] border-accent bg-accent">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </div>
                  <span class="flex-1 truncate text-[13px] font-medium text-white">{c.name}</span>
                </button>
              {/each}
            </div>
          {:else if runAuditStep === 2}
            <p class="mb-4 text-[13px] leading-relaxed text-content-dim">Which time window of agent activity should this audit sample?</p>
            <div class="grid grid-cols-2 gap-2">
              {#each [
                { id: "24h", label: "Last 24 hours", desc: "~30 tasks" },
                { id: "7d", label: "Last 7 days", desc: "~200 tasks · recommended" },
                { id: "30d", label: "Last 30 days", desc: "~800 tasks" },
                { id: "custom", label: "Custom…", desc: "Pick a date range" },
              ] as w}
                <button
                  type="button"
                  class="flex cursor-pointer flex-col gap-1 rounded-lg border p-3.5 text-left transition-all {w.id === '7d' ? 'border-edge-light' : 'border-edge hover:border-edge-light'}"
                  style={w.id === "7d" ? "background-color: var(--bg-elevated);" : ""}
                >
                  <span class="text-[13px] font-medium text-white">{w.label}</span>
                  <span class="text-[11px] text-content-muted">{w.desc}</span>
                </button>
              {/each}
            </div>
          {:else if runAuditStep === 3}
            <p class="mb-4 text-[13px] leading-relaxed text-content-dim">Ready to run.</p>
            <div class="overflow-hidden rounded-xl border border-edge bg-deeper">
              <div class="flex items-center justify-between border-b border-edge px-5 py-3">
                <span class="text-[13px] text-content-dim">Agents</span>
                <span class="text-[13px] font-medium text-white">{mockAgents.length} agents</span>
              </div>
              <div class="flex items-center justify-between border-b border-edge px-5 py-3">
                <span class="text-[13px] text-content-dim">Criteria</span>
                <span class="text-[13px] font-medium text-white">{mockCriteria.filter(c => c.enabled).length} active</span>
              </div>
              <div class="flex items-center justify-between border-b border-edge px-5 py-3">
                <span class="text-[13px] text-content-dim">Window</span>
                <span class="text-[13px] font-medium text-white">Last 7 days</span>
              </div>
              <div class="flex items-center justify-between px-5 py-3">
                <span class="text-[13px] text-content-dim">Repeat</span>
                <div class="flex items-center gap-1.5">
                  {#each [{ label: "Once" }, { label: "Daily" }, { label: "Weekly" }] as opt}
                    <span class="cursor-pointer rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors {opt.label === 'Once' ? 'border-accent bg-accent/20 text-white' : 'border-edge text-content-dim hover:text-white'}">
                      {opt.label}
                    </span>
                  {/each}
                </div>
              </div>
            </div>
            <p class="mt-4 text-center text-[12px] text-content-muted">Results appear in your review queue when done.</p>
          {/if}
        </div>

        <!-- Footer -->
        <div class="flex shrink-0 items-center border-t border-edge px-6 py-3.5 bg-deeper">
          <div class="flex-1"></div>
          <div class="flex items-center gap-2">
            {#if runAuditStep > 0}
              <button type="button" onclick={() => { runAuditStep--; }} class="cursor-pointer px-3 py-1.5 text-[12px] text-content-muted hover:text-content">Back</button>
            {/if}
            {#if runAuditStep < 3}
              <button
                type="button"
                onclick={() => { runAuditStep++; }}
                class="btn-primary flex cursor-pointer items-center gap-1.5 rounded-lg px-4 py-2 text-[12px] font-semibold"
              >
                Continue
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </button>
            {:else}
              <button
                type="button"
                onclick={() => { showRunAudit = false; showToast("Audit dispatched"); }}
                class="btn-primary flex cursor-pointer items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-semibold"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z" /></svg>
                Launch audit
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!-- REC DETAIL MODAL                                                    -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  {#if showRecDetail && activeRec}
    {@const recMeta = KIND_META[activeRec.kind] ?? { label: activeRec.kind, color: "var(--text-muted)", icon: "M12 12h.01" }}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-10"
      onclick={closeRecDetail}
      style="background: color-mix(in srgb, var(--background) 72%, transparent); backdrop-filter: blur(4px);"
      role="dialog"
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-edge bg-surface-alt"
        style="max-height: calc(100vh - 80px); box-shadow: 0 24px 60px rgba(0,0,0,0.5);"
        onclick={(e) => e.stopPropagation()}
      >
        <!-- Header -->
        <div class="flex shrink-0 items-center gap-3 border-b border-edge px-5 py-4">
          <Badge
            variant="tag"
            style="color: {recMeta.color}; background-color: color-mix(in srgb, {recMeta.color} 10%, transparent); border-color: color-mix(in srgb, {recMeta.color} 25%, transparent);"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d={recMeta.icon} />
            </svg>
            {recMeta.label}
          </Badge>
          <div class="flex-1"></div>
          <button type="button" aria-label="Close" onclick={closeRecDetail} class="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-raised hover:text-white">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-auto px-5 pt-5 pb-0">
          <div class="mb-4">
            <h3 class="mb-2 text-[20px] font-semibold leading-snug text-white" style="letter-spacing: -0.01em;">{activeRec.text}</h3>
          </div>

          <!-- Metrics -->
          <div class="mb-5 grid grid-cols-4 gap-2.5">
            {#each [
              { label: "Effort", value: activeRec.effort, hint: activeRec.effort === "low" ? "~2 min" : activeRec.effort === "medium" ? "~15 min" : "~1 hr" },
              { label: "Expected lift", value: activeRec.lift, hint: activeRec.lift === "high" ? "+5 to +10" : activeRec.lift === "medium" ? "+2 to +5" : "<2" },
              { label: "Auto-apply", value: activeRec.kind === "file_change" ? "Eligible" : "N/A", hint: activeRec.kind === "file_change" ? "dry-run passed" : "Not a file change" },
              { label: "Reversible", value: "Yes", hint: "1-click revert" },
            ] as metric}
              <div class="rounded-lg border border-edge px-3 py-2.5 bg-raised">
                <div class="text-[10px] uppercase tracking-wider text-content-muted">{metric.label}</div>
                <div class="mt-0.5 text-[13px] font-medium capitalize text-white">{metric.value}</div>
                <div class="mt-0.5 text-[11px] text-content-dim">{metric.hint}</div>
              </div>
            {/each}
          </div>

          <!-- Why -->
          <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Why this change</span>
          <p class="mb-4 text-[13px] leading-relaxed text-content">{activeRec.reasoning}</p>

          <!-- Evidence -->
          {#if activeRec.evidence}
            <div class="mb-4 rounded-lg border px-2.5 py-2" style="background-color: color-mix(in srgb, var(--color-error) 8%, transparent); border-color: color-mix(in srgb, var(--color-error) 22%, transparent);">
              <div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-score-critical">Evidence</div>
              <div class="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-content-dim">{activeRec.evidence}</div>
            </div>
          {/if}

          <!-- Diff preview for file_change -->
          {#if activeRec.kind === "file_change" && (activeRec.currentContent || activeRec.proposedContent)}
            <div class="mb-4">
              <div class="mb-2 flex items-baseline justify-between">
                <span class="text-[11px] font-semibold uppercase tracking-wider text-content-muted">Proposed change</span>
                {#if activeRec.file}
                  <span class="font-mono text-[11px] text-content-muted">{activeRec.file}</span>
                {/if}
              </div>
              <div class="overflow-hidden rounded-lg border border-edge bg-deeper">
                <div class="flex items-center gap-2.5 border-b border-edge px-3 py-1.5 font-mono text-[11px] text-content-muted">
                  <span>@@ diff @@</span>
                </div>
                <div class="py-1.5">
                  {#each (activeRec.currentContent ?? "").split("\n") as line}
                    <div class="px-3 py-0.5 font-mono text-[12px] leading-relaxed text-score-critical" style="background-color: rgba(239,68,68,0.08);">
                      <span class="mr-2 inline-block w-4 text-content-muted">−</span>{line}
                    </div>
                  {/each}
                  {#each (activeRec.proposedContent ?? "").split("\n") as line}
                    <div class="px-3 py-0.5 font-mono text-[12px] leading-relaxed text-score-healthy" style="background-color: rgba(16,185,129,0.08);">
                      <span class="mr-2 inline-block w-4 text-content-muted">+</span>{line}
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          {/if}
        </div>

        <!-- Footer -->
        <div class="flex shrink-0 items-center gap-2.5 border-t border-edge px-5 py-3.5 bg-deeper">
          <div class="flex-1"></div>
          <button type="button" onclick={() => { closeRecDetail(); showToast("Dismissed"); }} class="cursor-pointer px-3 py-1.5 text-[12px] text-content-muted hover:text-content">Dismiss</button>
          <button
            type="button"
            onclick={() => { closeRecDetail(); showToast(activeRec?.kind === "action" ? "Task created" : activeRec?.kind === "observation" ? "Acknowledged" : "Change applied"); }}
            class="btn-primary flex cursor-pointer items-center gap-1.5 rounded-lg px-4 py-1.5 text-[12px] font-semibold"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            {activeRec.kind === "action" ? "Create task" : activeRec.kind === "observation" ? "Acknowledge" : "Apply change"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!-- PROVIDER SETUP MODAL                                                -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  {#if showProviderSetup}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-6"
      onclick={() => { showProviderSetup = false; }}
      style="background: color-mix(in srgb, var(--background) 72%, transparent); backdrop-filter: blur(4px);"
      role="dialog"
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex flex-col overflow-hidden rounded-2xl border border-edge bg-surface-alt"
        style="width: 540px; max-width: 100%; max-height: 85vh; box-shadow: 0 24px 60px rgba(0,0,0,0.4);"
        onclick={(e) => e.stopPropagation()}
      >
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-edge px-5 py-4">
          <div class="flex items-center gap-3">
            <div class="flex h-8 w-8 items-center justify-center rounded-lg" style="background-color: color-mix(in srgb, var(--color-link) 12%, transparent);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-link)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <h3 class="text-[16px] font-semibold text-white">Audit evaluation provider</h3>
              <p class="text-[11px] text-content-muted">Configure the LLM provider for scoring audits</p>
            </div>
          </div>
          <button type="button" aria-label="Close" onclick={() => { showProviderSetup = false; }} class="cursor-pointer rounded-md p-1.5 text-content-muted transition-colors hover:bg-raised hover:text-white">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex flex-1 flex-col gap-5 overflow-auto p-5">
          <!-- Provider selection -->
          <div>
            <span class="mb-2.5 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Provider</span>
            <div class="flex gap-2.5">
              {#each [{ id: "azure", name: "Azure AI Foundry", desc: "DeepSeek, Grok, Claude models via Azure" }, { id: "openrouter", name: "OpenRouter", desc: "Community and open-source models" }] as prov}
                <button
                  type="button"
                  class="flex flex-1 cursor-pointer flex-col gap-1.5 rounded-xl border border-edge p-3.5 text-left transition-all hover:border-edge-light"
                >
                  <span class="text-[13px] font-medium text-white">{prov.name}</span>
                  <span class="text-[11px] leading-snug text-content-muted">{prov.desc}</span>
                </button>
              {/each}
            </div>
          </div>
          <!-- API Key -->
          <div>
            <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">API Key</span>
            <input
              type="password"
              placeholder="Enter your API key"
              class="w-full rounded-lg border border-edge bg-transparent px-3.5 py-2.5 font-mono text-[13px] text-white transition-colors placeholder:text-content-muted focus:border-edge-light focus:outline-none"
            />
          </div>
          <!-- Model -->
          <div>
            <span class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-content-muted">Model</span>
            <input
              type="text"
              placeholder="e.g. DeepSeek-V3, grok-4, claude-sonnet-4-5"
              class="w-full rounded-lg border border-edge bg-transparent px-3.5 py-2.5 font-mono text-[13px] text-white transition-colors placeholder:text-content-muted focus:border-edge-light focus:outline-none"
            />
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-edge px-5 py-3.5 bg-deeper">
          <button type="button" onclick={() => { showProviderSetup = false; }} class="cursor-pointer px-3 py-1.5 text-[12px] text-content-muted hover:text-content">Cancel</button>
          <button type="button" onclick={() => { showProviderSetup = false; showToast("Provider saved"); }} class="btn-primary cursor-pointer rounded-lg px-4 py-1.5 text-[12px] font-semibold">
            Save provider
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Toast -->
  {#if toast}
    <div class="fixed bottom-6 left-1/2 z-[var(--z-menu)] -translate-x-1/2 animate-page-in rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white shadow-2xl">
      {toast}
    </div>
  {/if}
</div>
