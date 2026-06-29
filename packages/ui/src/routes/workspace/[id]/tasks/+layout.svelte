<!--
  Tasks shell layout — wraps every /workspace/<ws>/tasks route. The project
  navigation is a TOP bar (TasksTopNav: project switcher dropdown + horizontal
  section tabs), not a left sidebar — so the routed view gets the full width
  below it. This renders INSIDE the workspace layout's <main>, so the chat/daemon
  sidebars are correctly absent on Tasks routes.
-->
<script lang="ts">
  import TasksTopNav from "$lib/components/tasks/TasksTopNav.svelte";

  let { children } = $props();
</script>

<div class="flex h-full w-full min-h-0 flex-col overflow-hidden">
  <TasksTopNav />
  <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
    {@render children()}
  </div>
</div>
