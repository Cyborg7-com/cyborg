<!--
  Tasks shell layout — wraps every /workspace/<ws>/tasks route. On DESKTOP the
  project navigation is the TasksTopNav (project switcher + section tabs). On
  MOBILE it is the tier-1 MobileTasksHeader (project name → switcher sheet) with
  the tier-2 section strip beneath; the routed view gets the full width below.
  Desktop is untouched. The single create-task sheet (driven by the shared
  openCreate store) is mounted here on mobile so openCreateTask works from any
  tasks route.
-->
<script lang="ts">
  import TasksTopNav from "$lib/components/tasks/TasksTopNav.svelte";
  import MobileTasksHeader from "$lib/components/tasks/mobile/MobileTasksHeader.svelte";
  import CreateTaskSheet from "$lib/components/tasks/mobile/CreateTaskSheet.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  let { children } = $props();
</script>

<div class="flex h-full w-full min-h-0 flex-col overflow-hidden">
  {#if viewportState.isMobile}
    <MobileTasksHeader />
  {:else}
    <TasksTopNav />
  {/if}
  <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
    {@render children()}
  </div>
</div>

{#if viewportState.isMobile}
  <CreateTaskSheet />
{/if}
