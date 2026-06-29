<script lang="ts">
  // "Link GitHub Repository to a Plane Project" — Plane's repo↔project bind modal
  // (Image #4). It picks a Tasks project (our analog of a Plane project) and a
  // GitHub repository from the chosen installation, maps the project's Issue Open /
  // Issue Closed task states, and chooses the sync direction (Bidirectional /
  // Unidirectional), then calls bindGithubRepoSync. In EDIT mode the project +
  // repository are FIXED (the server's PATCH only changes the direction + the
  // issue-state map), so those pickers render as static rows and Save calls
  // patchGithubRepoSync.
  //
  // When MULTIPLE installations exist an Account / Organization picker comes first
  // (we never auto-pick when >1). When the GitHub App's live creds are absent the
  // repo dropdown degrades to a manual repo-entry form, mirroring ConnectGithubPanel.
  //
  // Token-only styling via the shared Tasks modal helpers ($lib/tasks/ui.ts) and the
  // bits-ui Dialog/Select primitives — dark + light both resolve. Verbatim Plane
  // integration copy (en/integration.json).
  import { client } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
  } from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    modalPanel,
    modalHeader,
    modalBody,
    modalFooter,
    fieldLabel,
    btnPrimary,
    btnSecondary,
  } from "$lib/tasks/ui.js";
  import {
    GITHUB_SYNC_DIRECTIONS,
    projectNameForTasksId,
    type GithubSyncDirection,
  } from "./github-states.js";
  import type {
    GithubInstallation,
    GithubInstallationRepo,
    GithubRepoSync,
    Project,
  } from "$lib/ws-client.js";
  import type { TaskState } from "$lib/core/types.js";

  let {
    open = $bindable(false),
    workspaceId,
    projects,
    installations,
    editSync = null,
    onSaved,
  }: {
    open?: boolean;
    workspaceId: string;
    // All Tasks projects in the workspace (client.fetchProjects → projects). Their
    // `id` is the tasks_projects.id the bind RPC resolves.
    projects: Project[];
    // Every GitHub App installation the workspace authorized (the account picker
    // source). The bind RPC takes the GitHub `installationId`, not the db `id`.
    installations: GithubInstallation[];
    // When set the modal edits an existing binding (PATCH path); project + repo are
    // fixed, only direction + the issue-state map change.
    editSync?: GithubRepoSync | null;
    onSaved?: () => void;
  } = $props();

  const isEdit = $derived(editSync !== null);

  // ── form state ──
  let projectId = $state("");
  let installationId = $state(""); // the GitHub installation id (not the db row id)
  let repoId = $state("");
  let repoOwner = $state("");
  let repoName = $state("");
  let repoUrl = $state("");
  let direction = $state<GithubSyncDirection>("bidirectional");
  let issueOpenStateId = $state<string | null>(null);
  let issueClosedStateId = $state<string | null>(null);

  // ── async-derived option sources ──
  let projectStates = $state<TaskState[]>([]);
  let repos = $state<GithubInstallationRepo[]>([]);
  // null = not yet probed; false = the App's live creds are absent (manual entry).
  let reposConfigured = $state<boolean | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // In CREATE mode `projectId` is the bare chat id chosen from the picker; in EDIT mode
  // it is seeded from editSync.tasksProjectId (the `tp_<chatId>` tasks_projects.id).
  // projectNameForTasksId resolves both, so the read-only "Plane Project" row renders
  // the name instead of "—" in edit mode.
  const selectedProjectName = $derived(projectNameForTasksId(projects, projectId));
  const selectedInstallation = $derived(
    installations.find((i) => i.installationId === installationId) ?? null,
  );
  const selectedRepoLabel = $derived(
    repoOwner && repoName ? `${repoOwner}/${repoName}` : "",
  );

  function installLabel(i: GithubInstallation): string {
    return i.accountType ? `${i.accountLogin} (${i.accountType})` : i.accountLogin;
  }

  // Seed (edit) / reset (create) every time the modal opens. A single installation
  // auto-selects (binding from exactly one account needs no choice); >1 forces the
  // Account picker (never auto-pick).
  $effect(() => {
    if (!open) return;
    error = null;
    busy = false;
    if (editSync) {
      projectId = editSync.tasksProjectId;
      installationId = editSync.installationId;
      repoId = editSync.repoId;
      repoOwner = editSync.owner;
      repoName = editSync.name;
      repoUrl = editSync.repoUrl;
      direction = editSync.syncDirection === "bidirectional" ? "bidirectional" : "inbound";
      issueOpenStateId = editSync.issueOpenStateId;
      issueClosedStateId = editSync.issueClosedStateId;
    } else {
      projectId = "";
      installationId = installations.length === 1 ? installations[0].installationId : "";
      repoId = "";
      repoOwner = "";
      repoName = "";
      repoUrl = "";
      direction = "bidirectional";
      issueOpenStateId = null;
      issueClosedStateId = null;
      repos = [];
      reposConfigured = null;
    }
  });

  // The chosen project's workflow states drive the Issue Open / Issue Closed pickers.
  $effect(() => {
    const proj = projectId;
    if (!proj) {
      projectStates = [];
      return;
    }
    let active = true;
    void client
      .fetchProjectStates(proj)
      .then((s) => {
        if (active) projectStates = s;
        return undefined;
      })
      .catch(() => {
        if (active) projectStates = [];
      });
    return () => {
      active = false;
    };
  });

  // Probe the installation's repositories once an account + project are chosen
  // (create mode only — edit keeps the bound repo). The probe scopes to the project
  // so the server can authorize it (BOLA guard). `configured:false` → manual entry.
  $effect(() => {
    if (isEdit) return;
    const inst = installationId;
    const proj = projectId;
    if (!inst || !proj) {
      repos = [];
      reposConfigured = null;
      return;
    }
    let active = true;
    void client
      .fetchGithubInstallationRepos(inst, proj)
      .then((res) => {
        if (!active) return;
        reposConfigured = res.configured;
        repos = res.repos;
        return undefined;
      })
      .catch(() => {
        if (!active) return;
        reposConfigured = false;
        repos = [];
      });
    return () => {
      active = false;
    };
  });

  function selectRepo(id: string): void {
    const r = repos.find((x) => x.repoId === id);
    if (!r) return;
    repoId = r.repoId;
    repoOwner = r.owner;
    repoName = r.name;
    repoUrl = r.repoUrl;
  }

  const canSubmit = $derived(
    isEdit ||
      (projectId.trim() !== "" &&
        installationId.trim() !== "" &&
        repoId.trim() !== "" &&
        repoOwner.trim() !== "" &&
        repoName.trim() !== ""),
  );

  async function submit(): Promise<void> {
    if (!canSubmit || busy) return;
    busy = true;
    error = null;
    try {
      if (isEdit && editSync) {
        await client.patchGithubRepoSync(editSync.id, {
          syncDirection: direction,
          issueOpenStateId,
          issueClosedStateId,
        });
      } else {
        await client.bindGithubRepoSync({
          tasksProjectId: projectId,
          installationId,
          repoId,
          owner: repoOwner,
          name: repoName,
          repoUrl: repoUrl || undefined,
          syncDirection: direction,
          issueOpenStateId,
          issueClosedStateId,
        });
      }
      open = false;
      onSaved?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save the repository link";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class={cn(modalPanel, "max-w-lg gap-0 p-0")}>
    <div class={modalHeader}>
      <DialogTitle class="text-[15px] font-semibold text-content">
        Link GitHub Repository to a Plane Project
      </DialogTitle>
      <DialogDescription class="sr-only">
        Pick a project and a GitHub repository, map the issue open and closed states, and
        choose the sync direction.
      </DialogDescription>
    </div>

    <div class={modalBody}>
      <!-- Plane Project -->
      <div class="flex flex-col gap-1.5">
        <span class={fieldLabel} id="gh-link-project-label">Plane Project</span>
        {#if isEdit}
          <div class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[13px] text-content">
            {selectedProjectName || "—"}
          </div>
        {:else}
          <Select.Root type="single" value={projectId} onValueChange={(v) => (projectId = v)}>
            <Select.Trigger aria-labelledby="gh-link-project-label">
              {#if selectedProjectName}
                {selectedProjectName}
              {:else}
                <span class="text-content-muted">Choose Project...</span>
              {/if}
            </Select.Trigger>
            <Select.Content>
              {#each projects as p (p.id)}
                <Select.Item value={p.id} label={p.name}>{p.name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {/if}
      </div>

      <!-- Account / Organization (only when more than one installation) -->
      {#if !isEdit && installations.length > 1}
        <div class="flex flex-col gap-1.5">
          <span class={fieldLabel} id="gh-link-account-label">Account / Organization</span>
          <Select.Root
            type="single"
            value={installationId}
            onValueChange={(v) => {
              installationId = v;
              repoId = "";
              repoOwner = "";
              repoName = "";
            }}
          >
            <Select.Trigger aria-labelledby="gh-link-account-label">
              {#if selectedInstallation}
                {installLabel(selectedInstallation)}
              {:else}
                <span class="text-content-muted">Choose Account...</span>
              {/if}
            </Select.Trigger>
            <Select.Content>
              {#each installations as i (i.id)}
                <Select.Item value={i.installationId} label={installLabel(i)}>
                  {installLabel(i)}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}

      <!-- GitHub Repository -->
      <div class="flex flex-col gap-1.5">
        <span class={fieldLabel} id="gh-link-repo-label">GitHub Repository</span>
        {#if isEdit}
          <div class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[13px] text-content">
            {selectedRepoLabel || "—"}
          </div>
        {:else if reposConfigured === false}
          <!-- Live repo discovery unavailable: enter the repo details manually. -->
          <p class="text-[12px] text-content-dim">
            Live repository discovery is unavailable; enter the repository details manually.
          </p>
          <div class="grid grid-cols-3 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-content-dim">Repo ID</span>
              <Input bind:value={repoId} placeholder="555" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-content-dim">Owner</span>
              <Input bind:value={repoOwner} placeholder="acme" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-content-dim">Name</span>
              <Input bind:value={repoName} placeholder="app" />
            </label>
          </div>
        {:else}
          <Select.Root
            type="single"
            value={repoId}
            onValueChange={(v) => selectRepo(v)}
            disabled={!installationId || !projectId || repos.length === 0}
          >
            <Select.Trigger aria-labelledby="gh-link-repo-label">
              {#if selectedRepoLabel}
                {selectedRepoLabel}
              {:else}
                <span class="text-content-muted">Choose Repository...</span>
              {/if}
            </Select.Trigger>
            <Select.Content>
              {#each repos as r (r.repoId)}
                <Select.Item value={r.repoId} label={`${r.owner}/${r.name}`}>
                  {r.owner}/{r.name}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if installationId && projectId && reposConfigured === true && repos.length === 0}
            <p class="text-[12px] text-content-dim">
              No repositories found for this account.
            </p>
          {/if}
        {/if}
      </div>

      <!-- Configure Issue Sync State -->
      <div class="flex flex-col gap-2 rounded-md border border-edge bg-surface-alt p-3">
        <span class="text-[13px] font-medium text-content">Configure Issue Sync State</span>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-content-dim">Issue Open</span>
          <StateDropdown
            value={issueOpenStateId}
            options={projectStates}
            variant="row"
            placeholder="Select State"
            disabled={projectStates.length === 0}
            onChange={(next) => (issueOpenStateId = next)}
          />
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-content-dim">Issue Closed</span>
          <StateDropdown
            value={issueClosedStateId}
            options={projectStates}
            variant="row"
            placeholder="Select State"
            disabled={projectStates.length === 0}
            onChange={(next) => (issueClosedStateId = next)}
          />
        </div>
      </div>

      <!-- Select issue sync direction -->
      <fieldset class="flex flex-col gap-2">
        <legend class={cn(fieldLabel, "mb-1")}>Select issue sync direction</legend>
        {#each GITHUB_SYNC_DIRECTIONS as opt (opt.value)}
          <label class="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="gh-sync-direction"
              value={opt.value}
              checked={direction === opt.value}
              onchange={() => (direction = opt.value)}
              class="mt-0.5 accent-[color:var(--c7-accent)]"
            />
            <span
              class={cn(
                "text-[13px]",
                opt.value === "inbound" ? "text-content-dim" : "text-content",
              )}
            >
              {opt.label}
            </span>
          </label>
        {/each}
      </fieldset>

      {#if error}
        <p class="text-[12px] text-error" role="alert">{error}</p>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} onclick={() => (open = false)}>Cancel</button>
      <button type="button" class={btnPrimary} onclick={submit} disabled={!canSubmit || busy}>
        {#if busy}
          {isEdit ? "Saving…" : "Starting…"}
        {:else}
          {isEdit ? "Save" : "Start Sync"}
        {/if}
      </button>
    </div>
  </DialogContent>
</Dialog>
