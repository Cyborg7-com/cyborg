<script lang="ts">
  // Project Overview route — thin wrapper around the ProjectOverview component
  // (the project landing summary: counts by state group, active cycle, recent
  // activity). The component derives everything from workspaceState.tasks + the
  // warm project cache + a best-effort states/cycles fetch, so it never blocks.
  import { page } from "$app/state";
  import { projectsCache } from "$lib/state/app.svelte.js";
  import { projectKeyPrefix } from "$lib/tasks/detail.js";
  import { INBOX_IDENTIFIER, isInboxProjectId } from "$lib/tasks/constants.js";
  import ProjectOverview from "$lib/components/tasks/ProjectOverview.svelte";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");

  // Until the client Project type carries the real `identifier`, derive the task-
  // key prefix from the project name (seam for the real identifier later). The
  // synthetic Inbox isn't in the chat-project cache, so it uses its "INBOX" key.
  const project = $derived(
    projectsCache.get(wsId)?.projects.find((p) => p.id === projectId) ?? null,
  );
  const projectIdentifier = $derived(
    isInboxProjectId(projectId) ? INBOX_IDENTIFIER : projectKeyPrefix(project?.name),
  );
</script>

<ProjectOverview {wsId} {projectId} {projectIdentifier} />
