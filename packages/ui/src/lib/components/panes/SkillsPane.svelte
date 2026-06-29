<script lang="ts">
  import { untrack } from "svelte";
  import { cn } from "$lib/utils.js";
  import EmptyState from "../EmptyState.svelte";

  let { workspaceId }: { workspaceId: string } = $props();

  interface SkillAssignment {
    id: string;
    agentId: string;
    deliveryStatus: "pending" | "delivered" | "failed";
    deliveryError?: string | null;
    assignedAt: string;
    agentName?: string | null;
    humanName: string;
  }

  interface Skill {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    content: string;
    sourceUrl?: string | null;
    addedByName?: string | null;
    createdAt: string;
    updatedAt: string;
    assignments: SkillAssignment[];
  }

  interface MockAgent {
    id: string;
    name: string;
    online: boolean;
  }

  const mockAgents: MockAgent[] = [
    { id: "a1", name: "Atlas", online: true },
    { id: "a2", name: "Rick", online: true },
    { id: "a3", name: "Beth", online: false },
    { id: "a4", name: "Caesar", online: true },
  ];

  function buildMockSkills(): Skill[] {
    return [
      {
        id: "s1",
        name: "Cyborg7 Collaboration",
        slug: "cyborg7-collab",
        description: "Use this skill EVERY TIME the agent communicates in a workspace channel or DM. Always follow the acknowledgement protocol.",
        content: `# Cyborg7 Collaboration Skill

## Communication Protocol

1. **Acknowledgement loop** — When assigned a task, always send an ack message in the channel confirming receipt.
2. **Mention etiquette** — Use @mentions sparingly. Only mention humans when you need a decision or approval.
3. **Thread replies** — Always reply in threads, never top-level, unless starting a new topic.

## Channel vs DM Rules

- \`#general\` — Announcements only. No chatter.
- \`#dev\` — Technical discussion. Code snippets welcome.
- \`#tasks\` — Task updates and status changes.
- **DMs** — Use for private queries, credential sharing, or 1:1 feedback.

## Task Lifecycle

When you receive a task:
1. Acknowledge in the source channel
2. Move status to \`in_progress\`
3. Post updates every 30 minutes for long-running tasks
4. Move to \`pending_review\` when done
5. Wait for human approval before marking \`done\`

## Read Receipts

Always mark messages as read after processing. Unread messages trigger reminder pings after 15 minutes.`,
        sourceUrl: "https://github.com/Cyborg7-com/cyborg7-skill",
        addedByName: "Rodrigo",
        createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        assignments: [
          { id: "sa1", agentId: "a1", deliveryStatus: "delivered", assignedAt: new Date().toISOString(), humanName: "Atlas" },
          { id: "sa2", agentId: "a2", deliveryStatus: "delivered", assignedAt: new Date().toISOString(), humanName: "Rick" },
          { id: "sa3", agentId: "a4", deliveryStatus: "pending", assignedAt: new Date().toISOString(), humanName: "Caesar" },
        ],
      },
      {
        id: "s2",
        name: "Code Review Standards",
        slug: "code-review",
        description: "Use this skill EVERY TIME you review a pull request or code diff. Always check for security vulnerabilities first.",
        content: `# Code Review Standards

## Priority Order

1. **Security** — Check for injection, auth bypass, secrets in code
2. **Correctness** — Does the code do what it claims?
3. **Performance** — Any O(n²) loops, missing indexes, unbounded queries?
4. **Readability** — Clear naming, reasonable function length, no magic numbers

## Review Checklist

- [ ] No hardcoded secrets or credentials
- [ ] Input validation on all user-facing endpoints
- [ ] Error handling doesn't leak internal state
- [ ] Database queries use parameterized statements
- [ ] Tests cover the happy path and at least one edge case

## Tone

Be constructive. Lead with what's good. Suggest, don't demand. Use "Consider..." or "What about..." instead of "You should..."`,
        addedByName: "Rodrigo",
        createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
        assignments: [
          { id: "sa4", agentId: "a1", deliveryStatus: "delivered", assignedAt: new Date().toISOString(), humanName: "Atlas" },
        ],
      },
      {
        id: "s3",
        name: "Deployment Procedure",
        slug: "deployment",
        description: "Use this skill EVERY TIME a deployment or release is requested. Always run the pre-flight checks before proceeding.",
        content: `# Deployment Procedure

## Pre-flight Checks

1. **All tests green** — CI must pass on the target branch
2. **No open blockers** — Check for P0/P1 issues tagged with the release
3. **Database migrations** — Run \`drizzle-kit check\` to verify schema state
4. **Changelog updated** — Ensure CHANGELOG.md reflects all changes

## Deploy Steps

- Tag the release: \`git tag v{version}\`
- Push to trigger CI/CD: \`git push origin v{version}\`
- Monitor the deploy dashboard for 15 minutes
- Run smoke tests against staging before promoting to production

## Rollback

If anything breaks post-deploy:
1. Revert the tag
2. Deploy the previous version
3. Open a post-mortem task`,
        addedByName: "Alex",
        createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        assignments: [
          { id: "sa5", agentId: "a2", deliveryStatus: "delivered", assignedAt: new Date().toISOString(), humanName: "Rick" },
          { id: "sa6", agentId: "a3", deliveryStatus: "failed", deliveryError: "Agent offline", assignedAt: new Date().toISOString(), humanName: "Beth" },
        ],
      },
    ];
  }

  let skills = $state<Skill[]>([]);
  let loading = $state(true);
  let selectedSkillId = $state<string | null>(null);
  let viewMode = $state<"view" | "code">("view");
  let search = $state("");
  let showAddModal = $state(false);
  let addMode = $state<"source" | "manual">("source");
  let showAssignDropdown = $state(false);
  let editMode = $state(false);
  let editDraft = $state({ name: "", description: "", content: "" });
  let saving = $state(false);
  let copied = $state<string | null>(null);

  let newSkill = $state({ name: "", slug: "", description: "", content: "" });
  let creating = $state(false);

  $effect(() => {
    void workspaceId;
    untrack(() => {
      skills = buildMockSkills();
      selectedSkillId = skills[0]?.id ?? null;
      loading = false;
    });
  });

  const displaySkills = $derived.by(() => {
    if (!search) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q),
    );
  });

  const selectedSkill = $derived(
    selectedSkillId ? skills.find((s) => s.id === selectedSkillId) ?? null : null,
  );

  function startEdit() {
    if (!selectedSkill) return;
    editDraft = { name: selectedSkill.name, description: selectedSkill.description ?? "", content: selectedSkill.content };
    editMode = true;
  }

  function cancelEdit() {
    editMode = false;
    editDraft = { name: "", description: "", content: "" };
  }

  function saveEdit() {
    if (!selectedSkill) return;
    saving = true;
    setTimeout(() => {
      const idx = skills.findIndex((s) => s.id === selectedSkill.id);
      if (idx >= 0) {
        skills[idx] = { ...skills[idx], name: editDraft.name, description: editDraft.description, content: editDraft.content, updatedAt: new Date().toISOString() };
      }
      editMode = false;
      saving = false;
    }, 400);
  }

  function handleDeleteSkill() {
    if (!selectedSkill) return;
    skills = skills.filter((s) => s.id !== selectedSkill.id);
    selectedSkillId = skills[0]?.id ?? null;
  }

  function handleCreateSkill() {
    if (!newSkill.name.trim() || !newSkill.slug.trim() || !newSkill.content.trim()) return;
    creating = true;
    setTimeout(() => {
      const created: Skill = {
        id: `s-${Date.now()}`,
        name: newSkill.name,
        slug: newSkill.slug,
        description: newSkill.description || null,
        content: newSkill.content,
        addedByName: "You",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        assignments: [],
      };
      skills = [...skills, created];
      selectedSkillId = created.id;
      showAddModal = false;
      newSkill = { name: "", slug: "", description: "", content: "" };
      creating = false;
    }, 400);
  }

  function handleAssignToggle(agentId: string) {
    if (!selectedSkill) return;
    const idx = skills.findIndex((s) => s.id === selectedSkill.id);
    if (idx < 0) return;
    const isAssigned = selectedSkill.assignments.some((a) => a.agentId === agentId);
    if (isAssigned) {
      skills[idx] = { ...skills[idx], assignments: skills[idx].assignments.filter((a) => a.agentId !== agentId) };
    } else {
      const agent = mockAgents.find((a) => a.id === agentId);
      if (!agent) return;
      skills[idx] = {
        ...skills[idx],
        assignments: [
          ...skills[idx].assignments,
          { id: `sa-${Date.now()}`, agentId, deliveryStatus: "pending", assignedAt: new Date().toISOString(), humanName: agent.name },
        ],
      };
    }
  }

  function resetAddModal() {
    showAddModal = false;
    addMode = "source";
    newSkill = { name: "", slug: "", description: "", content: "" };
  }

  function copyContent() {
    if (!selectedSkill) return;
    navigator.clipboard.writeText(selectedSkill.content);
    copied = "code";
    setTimeout(() => (copied = null), 2000);
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as Node;
    const el = document.getElementById("assign-dropdown");
    if (showAssignDropdown && el && !el.contains(target)) showAssignDropdown = false;
  }
</script>

<svelte:document onclick={handleClickOutside} />

<div class="flex h-full flex-col bg-surface-alt text-content">
  <!-- Breadcrumb -->
  <div class="flex h-[36px] shrink-0 items-center gap-2 border-b border-edge px-4 text-[12px] text-content-dim">
    <span>Skills</span>
    {#if selectedSkill}
      <span class="text-content-muted">&gt;</span>
      <span class="text-content">{selectedSkill.name}</span>
    {/if}
  </div>

  <!-- Main layout -->
  <div class="flex min-h-0 flex-1">
    <!-- Left sidebar -->
    <div class="flex w-[280px] shrink-0 flex-col border-r border-edge">
      <div class="px-4 pb-2 pt-4">
        <div class="mb-1 flex items-center justify-between">
          <div>
            <span class="text-[14px] font-semibold text-content">Skills</span>
            <span class="ml-1 text-[11px] text-content-muted">{displaySkills.length} available</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              onclick={() => { skills = buildMockSkills(); }}
              class={cn("cursor-pointer rounded p-1.5 text-content-dim transition-colors hover:bg-raised hover:text-content", loading && "animate-spin")}
              aria-label="Refresh skills"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8a6 6 0 0110.89-3.48M14 2v4h-4M14 8a6 6 0 01-10.89 3.48M2 14v-4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button
              type="button"
              onclick={() => { showAddModal = true; addMode = "source"; }}
              class="cursor-pointer rounded p-1.5 text-content-dim transition-colors hover:bg-raised hover:text-content"
              aria-label="Add skill"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
        <input
          bind:value={search}
          placeholder="Filter skills"
          class="mt-2 w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-[13px] text-content placeholder-content-muted transition-colors focus:border-edge-light focus:outline-none focus:ring-1 focus:ring-edge-light"
        />
      </div>
      <div class="flex-1 overflow-y-auto px-2 py-1">
        {#if loading && skills.length === 0}
          <div class="flex items-center justify-center py-8 text-[12px] text-content-muted">Loading skills...</div>
        {:else if displaySkills.length === 0}
          <EmptyState
            iconWrap={false}
            title={skills.length === 0 ? "No skills yet" : "No matches"}
            description={skills.length === 0 ? "See the welcome panel" : "Try a different filter"}
            class="px-3 py-10"
            titleClass="text-[13px] font-medium text-content-dim"
            descriptionClass="mt-0.5 text-[11px] text-content-muted"
          >
            {#snippet icon()}
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" class="text-edge" aria-hidden="true">
                <path d="M13 3l-4 7h5l-1 7 8-9h-5l2-5H13z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {/snippet}
            {#snippet action()}
              <button
                type="button"
                onclick={() => (showAddModal = true)}
                class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-[12px] font-medium text-content transition-colors hover:bg-raised"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                Add a skill
              </button>
            {/snippet}
          </EmptyState>
        {:else}
          {#each displaySkills as skill (skill.id)}
            <button
              type="button"
              onclick={() => { selectedSkillId = skill.id; viewMode = "view"; editMode = false; }}
              class={cn(
                "mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-[14px] transition-colors",
                selectedSkillId === skill.id ? "bg-edge text-content" : "text-content-dim hover:bg-raised",
              )}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="shrink-0 opacity-50" aria-hidden="true"><path d="M7 3l-4 7h5l-1 7 8-9h-5l2-5H7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="truncate">{skill.name}</span>
              <svg width="8" height="8" viewBox="0 0 8 8" class="ml-auto shrink-0 opacity-30" aria-hidden="true"><path d="M3 1l3 3-3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Right panel -->
    {#if selectedSkill}
      <div class="flex min-w-0 flex-1 flex-col">
        <!-- Skill header -->
        <div class="border-b border-edge px-6 pb-4 pt-5">
          <div class="flex items-center justify-between">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" class="shrink-0" aria-hidden="true"><path d="M7 3l-4 7h5l-1 7 8-9h-5l2-5H7z" stroke="var(--icon-gray)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              {#if editMode}
                <input
                  bind:value={editDraft.name}
                  class="flex-1 rounded-lg border border-edge-light px-3 py-1.5 text-[18px] font-bold text-content focus:border-edge-light focus:outline-none"
                  style="background-color: var(--bg-raised);"
                />
              {:else}
                <h2 class="truncate text-[20px] font-bold text-content">{selectedSkill.name}</h2>
              {/if}
            </div>
            <div class="ml-3 flex shrink-0 items-center gap-2">
              {#if editMode}
                <button type="button" onclick={cancelEdit} class="cursor-pointer px-3 py-1.5 text-[12px] text-content-dim hover:text-content">Cancel</button>
                <button
                  type="button"
                  onclick={saveEdit}
                  disabled={saving || !editDraft.name.trim() || !editDraft.content.trim()}
                  class="cursor-pointer rounded-lg bg-teal px-3 py-1.5 text-[12px] font-medium text-teal-contrast disabled:opacity-30"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              {:else}
                <button
                  type="button"
                  onclick={startEdit}
                  title="Edit skill"
                  class="cursor-pointer rounded p-1.5 text-content-muted transition-colors hover:bg-raised hover:text-content"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button
                  type="button"
                  onclick={handleDeleteSkill}
                  title="Delete skill"
                  class="cursor-pointer rounded p-1.5 text-content-muted transition-colors hover:text-error"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              {/if}
            </div>
          </div>

          <!-- Metadata rows -->
          <div class="mt-3 flex items-center gap-5 text-[12px]">
            <span class="uppercase tracking-wider text-content-muted">Slug</span>
            <span class="font-mono text-content-dim">{selectedSkill.slug}</span>
          </div>

          <div class="mt-2 text-[12px]">
            <span class="uppercase tracking-wider text-content-muted">Trigger</span>
            {#if editMode}
              <textarea
                bind:value={editDraft.description}
                rows={2}
                placeholder="Use this skill EVERY TIME [condition]. When active, always [behavior]."
                class="mt-1 w-full resize-none rounded-lg border border-edge-light px-3 py-2 text-[12px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              ></textarea>
            {:else if selectedSkill.description}
              <span class="ml-3 italic text-content-dim">{selectedSkill.description}</span>
            {:else}
              <span class="ml-3 italic text-content-muted">No trigger set</span>
            {/if}
          </div>

          {#if selectedSkill.addedByName}
            <div class="mt-1 text-[12px]">
              <span class="uppercase tracking-wider text-content-muted">Added by</span>
              <span class="ml-3 text-content">{selectedSkill.addedByName}</span>
              <span class="ml-1.5 rounded bg-teal/15 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-teal">human</span>
            </div>
          {/if}

          {#if selectedSkill.sourceUrl}
            <div class="mt-1 text-[12px]">
              <span class="uppercase tracking-wider text-content-muted">Source</span>
              <span class="ml-3 break-all text-link">{selectedSkill.sourceUrl.replace(/^https:\/\//, "")}</span>
            </div>
          {/if}

          <!-- Used by + assign -->
          <div class="relative mt-1 flex items-center gap-2 text-[12px]">
            <span class="uppercase tracking-wider text-content-muted">Used by</span>
            <div class="flex flex-wrap items-center gap-2">
              {#if selectedSkill.assignments.length === 0}
                <span class="text-content-muted">No agents assigned</span>
              {:else}
                {#each selectedSkill.assignments as a}
                  <span class="flex items-center gap-1 text-content">
                    {a.agentName ?? a.humanName}
                    {#if a.deliveryStatus === "delivered"}
                      <span title="Delivered" class="text-online">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      </span>
                    {:else if a.deliveryStatus === "failed"}
                      <span title={a.deliveryError ?? "Delivery failed"} class="text-red-400">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                      </span>
                    {:else}
                      <span title="Pending delivery" class="relative inline-flex h-3 w-3 items-center justify-center">
                        <span class="absolute inset-0 animate-spin rounded-full border border-content-dim border-t-transparent"></span>
                      </span>
                    {/if}
                  </span>
                {/each}
              {/if}
            </div>
            <div class="relative inline-block" id="assign-dropdown">
              <button
                type="button"
                onclick={() => (showAssignDropdown = !showAssignDropdown)}
                class="ml-2 cursor-pointer text-[11px] font-medium text-teal hover:opacity-80"
              >
                + Assign
              </button>
              {#if showAssignDropdown}
                <div
                  class="absolute left-0 top-full z-20 mt-1 max-h-[220px] w-[var(--panel-default)] overflow-y-auto rounded-lg border border-edge bg-surface-alt py-1 shadow-xl"
                >
                  <div class="border-b border-edge px-3 py-2">
                    <span class="text-[11px] text-content-muted">Assign "{selectedSkill.name}" to agents</span>
                  </div>
                  {#each mockAgents as agent}
                    {@const isAssigned = selectedSkill.assignments.some((a) => a.agentId === agent.id)}
                    <button
                      type="button"
                      onclick={() => handleAssignToggle(agent.id)}
                      class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] transition-colors hover:bg-raised"
                    >
                      <span class={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", isAssigned ? "border-[var(--color-teal,#14b8a6)] bg-[var(--color-teal,#14b8a6)]" : "border-content-muted")}>
                        {#if isAssigned}
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8l4 4 6-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        {/if}
                      </span>
                      <span class={isAssigned ? "text-content" : "text-content-dim"}>{agent.name}</span>
                      <span class={cn("ml-auto h-2 w-2 rounded-full", agent.online ? "bg-online" : "bg-content-muted")}></span>
                    </button>
                  {/each}
                  <div class="border-t border-edge px-3 py-2">
                    <button type="button" onclick={() => (showAssignDropdown = false)} class="cursor-pointer text-[11px] text-content-dim hover:text-content">Done</button>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- View/Code toggle -->
        {#if !editMode}
          <div class="flex items-center justify-between border-b border-edge px-6 py-2.5">
            <span class="text-[12px] text-content-muted">SKILL.md</span>
            <div class="flex items-center overflow-hidden rounded-lg" style="background-color: var(--bg-raised);">
              <button
                type="button"
                onclick={() => (viewMode = "view")}
                class={cn("flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-colors", viewMode === "view" ? "text-content" : "text-content-dim")}
                style={viewMode === "view" ? "background-color: var(--bg-edge);" : ""}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5S1 8 1 8z" stroke="currentColor" stroke-width="1.2"/></svg>
                View
              </button>
              <button
                type="button"
                onclick={() => (viewMode = "code")}
                class={cn("flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-colors", viewMode === "code" ? "text-content" : "text-content-dim")}
                style={viewMode === "code" ? "background-color: var(--bg-edge);" : ""}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 4L1 8l4 4M11 4l4 4-4 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Code
              </button>
            </div>
          </div>
        {/if}

        <!-- Content area -->
        <div class="flex-1 overflow-y-auto px-6 py-5">
          {#if editMode}
            <div>
              <label for="skill-edit-content" class="mb-1.5 block text-[11px] uppercase tracking-wider text-content-muted">SKILL.md content</label>
              <textarea
                id="skill-edit-content"
                bind:value={editDraft.content}
                class="w-full resize-y rounded-lg border border-edge px-4 py-3 font-mono text-[12px] leading-[1.7] text-content focus:border-edge-light focus:outline-none"
                style="min-height: 320px; background-color: var(--color-syntax-bg, var(--bg-raised));"
              ></textarea>
              <p class="mt-1 text-[10px] text-content-muted">{editDraft.content.length} chars</p>
            </div>
          {:else if viewMode === "view"}
            <div class="skill-markdown">
              {#each selectedSkill.content.split("\n") as line, li}
                {#if line.startsWith("# ")}
                  <h1 class="mb-3 mt-0 text-[22px] font-bold text-content">{line.slice(2)}</h1>
                {:else if line.startsWith("## ")}
                  <h2 class="mb-2 mt-6 text-[17px] font-bold text-content">{line.slice(3)}</h2>
                {:else if line.startsWith("### ")}
                  <h3 class="mb-1 mt-4 text-[14px] font-semibold text-content">{line.slice(4)}</h3>
                {:else if line.startsWith("- [ ] ")}
                  <div class="flex items-start gap-2 py-0.5 pl-4">
                    <span class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-content-muted"></span>
                    <span class="text-[14px] text-content">{line.slice(6)}</span>
                  </div>
                {:else if line.startsWith("- `")}
                  {@const match = line.match(/^- `(.+?)`\s*—?\s*(.*)$/)}
                  {#if match}
                    <div class="flex items-start gap-2 py-0.5 pl-4">
                      <span class="shrink-0 text-content-muted">&bull;</span>
                      <code class="rounded px-1.5 py-0.5 font-mono text-[12px] text-content" style="background-color: var(--bg-raised);">{match[1]}</code>
                      {#if match[2]}
                        <span class="text-[13px] text-content-dim"> — {match[2]}</span>
                      {/if}
                    </div>
                  {:else}
                    <div class="flex items-start gap-2 py-0.5 pl-4">
                      <span class="shrink-0 text-content-muted">&bull;</span>
                      <span class="text-[14px] text-content">{line.slice(2)}</span>
                    </div>
                  {/if}
                {:else if line.startsWith("- **")}
                  {@const match = line.match(/^- \*\*(.+?)\*\*\s*—?\s*(.*)$/)}
                  {#if match}
                    <div class="flex items-start gap-2 py-0.5 pl-4">
                      <span class="shrink-0 text-content-muted">&bull;</span>
                      <span class="text-[14px] text-content"><strong class="font-semibold">{match[1]}</strong>{match[2] ? ` — ${match[2]}` : ""}</span>
                    </div>
                  {:else}
                    <div class="flex items-start gap-2 py-0.5 pl-4">
                      <span class="shrink-0 text-content-muted">&bull;</span>
                      <span class="text-[14px] text-content">{line.slice(2)}</span>
                    </div>
                  {/if}
                {:else if line.startsWith("- ")}
                  <div class="flex items-start gap-2 py-0.5 pl-4">
                    <span class="shrink-0 text-content-muted">&bull;</span>
                    <span class="text-[14px] text-content">{line.slice(2)}</span>
                  </div>
                {:else if /^\d+\.\s\*\*/.test(line)}
                  {@const match = line.match(/^(\d+)\.\s\*\*(.+?)\*\*\s*—?\s*(.*)$/)}
                  {#if match}
                    <div class="flex items-start gap-2 py-1 pl-4">
                      <span class="shrink-0 text-content-muted">{match[1]}.</span>
                      <span class="text-[14px] text-content"><strong class="font-semibold">{match[2]}</strong>{match[3] ? ` — ${match[3]}` : ""}</span>
                    </div>
                  {:else}
                    <p class="text-[14px] leading-[1.8] text-content-dim">{line}</p>
                  {/if}
                {:else if line.trim() === ""}
                  <div class="h-3"></div>
                {:else}
                  <p class="text-[14px] leading-[1.8] text-content-dim">{line}</p>
                {/if}
              {/each}
            </div>
          {:else}
            <!-- Code view -->
            <div class="relative overflow-hidden rounded-lg border border-edge" style="background-color: var(--color-syntax-bg, var(--bg-raised));">
              <button
                type="button"
                onclick={copyContent}
                class="absolute right-3 top-3 z-10 cursor-pointer rounded px-2.5 py-1 text-[11px] text-content-dim transition-colors hover:text-content"
                style="background-color: var(--bg-raised);"
              >
                {copied === "code" ? "Copied!" : "Copy"}
              </button>
              <pre class="p-4 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-words">{#each selectedSkill.content.split("\n") as line, li}<div><span class="mr-4 inline-block w-6 select-none text-right" style="color: var(--color-syntax-text, currentColor); opacity: 0.4;">{li + 1}</span>{#if line.startsWith("#")}<span style="color: var(--color-syntax-text, currentColor); opacity: 0.6;">{line}</span>{:else if line.startsWith("- ") || line.startsWith("* ")}<span style="color: var(--color-syntax-keyword, #16a34a);">{line}</span>{:else}<span style="color: var(--color-syntax-text, currentColor);">{line}</span>{/if}</div>{/each}</pre>
            </div>
          {/if}
        </div>
      </div>
    {:else if loading}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-[13px] text-content-muted">Loading...</span>
      </div>
    {:else if skills.length === 0}
      <!-- Welcome panel -->
      <div class="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
        <div class="w-full max-w-[520px]">
          <div class="mb-6 text-center">
            <h2 class="mb-1.5 text-[22px] font-bold text-content">Get started with skills</h2>
            <p class="text-[13px] leading-relaxed text-content-dim">
              Skills are reusable instructions your agents read before acting — the platform-specific knowledge they need to behave well here.
            </p>
          </div>

          <div class="mb-4 rounded-xl border p-5" style="border-color: var(--c7-accent, #6366f1); background-color: rgba(99,102,241,0.05);">
            <span
              class="mb-2.5 inline-block rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style="color: var(--c7-accent); border-color: rgba(99,102,241,0.3); background-color: rgba(99,102,241,0.1);"
            >
              Recommended starter
            </span>
            <h3 class="mb-1.5 text-[16px] font-semibold text-content">Cyborg7 collaboration skill</h3>
            <p class="mb-4 text-[13px] leading-relaxed text-content-dim">
              Teaches your agents how to behave on this platform — channels vs DMs, mentions, tasks, ack loops, read receipts. Install once per workspace.
            </p>
            <button
              type="button"
              onclick={() => (showAddModal = true)}
              class="cursor-pointer rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground"
            >
              Install starter skill
            </button>
          </div>

          <div class="flex items-center gap-3 text-[12px] text-content-muted">
            <span class="h-px flex-1 bg-edge"></span>
            <span>Or</span>
            <span class="h-px flex-1 bg-edge"></span>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => (showAddModal = true)}
              class="cursor-pointer rounded-lg border border-edge px-4 py-3 text-left transition-colors hover:border-edge-light"
            >
              <span class="mb-0.5 block text-[13px] font-semibold text-content">Add from URL</span>
              <span class="text-[11px] text-content-dim">Paste a GitHub repo or SKILL.md link.</span>
            </button>
            <button
              type="button"
              onclick={() => { showAddModal = true; addMode = "manual"; }}
              class="cursor-pointer rounded-lg border border-edge px-4 py-3 text-left transition-colors hover:border-edge-light"
            >
              <span class="mb-0.5 block text-[13px] font-semibold text-content">Create manually</span>
              <span class="text-[11px] text-content-dim">Write the skill content yourself.</span>
            </button>
          </div>
        </div>
      </div>
    {:else}
      <!-- No skill selected -->
      <div class="flex flex-1 flex-col items-center justify-center gap-3">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" class="text-edge" aria-hidden="true">
          <path d="M13 3l-4 7h5l-1 7 8-9h-5l2-5H13z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="text-center">
          <p class="text-[14px] font-medium text-content-dim">No skill selected</p>
          <p class="mt-1 text-[12px] text-content-muted">Select a skill from the sidebar or create a new one</p>
        </div>
      </div>
    {/if}
  </div>

  <!-- Add skill modal -->
  {#if showAddModal}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onclick={resetAddModal}
      onkeydown={(e) => { if (e.key === "Escape") resetAddModal(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Add a skill"
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
      <div
        class="flex max-h-[85vh] w-[480px] flex-col rounded-xl border border-edge bg-surface-alt shadow-2xl"
        onclick={(e) => e.stopPropagation()}
      >
        {#if addMode === "source"}
          <div class="flex shrink-0 items-center justify-between px-5 pb-3 pt-5">
            <h3 class="text-[18px] font-bold text-content">Add a skill</h3>
            <button type="button" onclick={resetAddModal} class="cursor-pointer text-content-dim hover:text-content" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="flex-1 overflow-y-auto px-5 pb-3">
            <p class="mb-3 text-[13px] text-content-dim">
              Paste a GitHub URL, browse the skill directory, or create a custom one.
            </p>

            <div class="mb-4 flex items-center gap-2">
              <input
                placeholder="GitHub URL or npx command"
                class="flex-1 rounded-lg border border-edge px-3 py-2.5 text-[13px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              />
              <button
                type="button"
                class="shrink-0 cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-foreground opacity-30"
                disabled
              >
                Fetch
              </button>
            </div>

            <div class="space-y-2">
              <button
                type="button"
                onclick={() => (addMode = "manual")}
                class="flex w-full cursor-pointer items-start rounded-lg border border-edge px-4 py-3.5 text-left transition-colors hover:border-edge-light"
              >
                <div class="flex-1">
                  <span class="block text-[14px] font-semibold text-content">Create manually</span>
                  <p class="mt-0.5 text-[12px] text-content-dim">Write the skill content and trigger yourself.</p>
                </div>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="ml-3 mt-1 shrink-0 text-content-dim" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
          <div class="flex shrink-0 justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" onclick={resetAddModal} class="cursor-pointer px-4 py-2 text-[13px] text-content-dim hover:text-content">Close</button>
          </div>
        {:else}
          <!-- Manual create mode -->
          <div class="flex shrink-0 items-center justify-between px-5 pb-3 pt-5">
            <div class="flex items-center gap-2">
              <button type="button" onclick={() => (addMode = "source")} class="cursor-pointer text-content-muted hover:text-content" aria-label="Back">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <h3 class="text-[18px] font-bold text-content">Create skill</h3>
            </div>
            <button type="button" onclick={resetAddModal} class="cursor-pointer text-content-dim hover:text-content" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="flex-1 space-y-3 overflow-y-auto px-5 pb-4">
            <div>
              <label for="new-skill-name" class="mb-1 block text-[11px] uppercase tracking-wider text-content-muted">Name</label>
              <input
                id="new-skill-name"
                bind:value={newSkill.name}
                oninput={() => { newSkill.slug = newSkill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }}
                placeholder="My Custom Skill"
                class="w-full rounded-lg border border-edge px-3 py-2.5 text-[13px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              />
            </div>
            <div>
              <label for="new-skill-slug" class="mb-1 block text-[11px] uppercase tracking-wider text-content-muted">Slug <span class="normal-case tracking-normal">(lowercase, hyphens)</span></label>
              <input
                id="new-skill-slug"
                bind:value={newSkill.slug}
                oninput={() => { newSkill.slug = newSkill.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"); }}
                placeholder="my-custom-skill"
                class="w-full rounded-lg border border-edge px-3 py-2.5 font-mono text-[13px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              />
            </div>
            <div>
              <label for="new-skill-trigger" class="mb-1 block text-[11px] uppercase tracking-wider text-content-muted">Trigger</label>
              <textarea
                id="new-skill-trigger"
                bind:value={newSkill.description}
                placeholder="Use this skill EVERY TIME [condition]. When active, always [specific behavior]."
                rows={3}
                class="w-full resize-none rounded-lg border border-edge px-3 py-2.5 text-[13px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              ></textarea>
              <p class="mt-1 text-[10px] text-content-muted">Start with <span class="text-content-dim">"Use this skill EVERY TIME..."</span></p>
            </div>
            <div>
              <label for="new-skill-content" class="mb-1 block text-[11px] uppercase tracking-wider text-content-muted">SKILL.md content</label>
              <textarea
                id="new-skill-content"
                bind:value={newSkill.content}
                placeholder={"# My Skill\n\nInstructions for the agent..."}
                rows={8}
                class="w-full resize-y rounded-lg border border-edge px-3 py-2.5 font-mono text-[13px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none"
                style="background-color: var(--bg-raised);"
              ></textarea>
              <span class="text-[10px] text-content-muted">{newSkill.content.length} / 50,000 chars</span>
            </div>
          </div>
          <div class="flex shrink-0 justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" onclick={() => (addMode = "source")} class="cursor-pointer px-4 py-2 text-[13px] text-content-dim hover:text-content">Cancel</button>
            <button
              type="button"
              onclick={handleCreateSkill}
              disabled={creating || !newSkill.name.trim() || !newSkill.slug.trim() || !newSkill.content.trim()}
              class="cursor-pointer rounded-lg bg-teal px-4 py-2 text-[13px] font-medium text-teal-contrast disabled:opacity-30"
            >
              {creating ? "Creating..." : "Create skill"}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
