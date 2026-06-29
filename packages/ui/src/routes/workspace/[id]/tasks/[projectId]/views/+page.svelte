<script lang="ts">
  // Project Views — Plane's saved-views surface (named layout + filter presets for
  // the Work Items board). No client RPC backs saved views yet, so this is the
  // navigable landing view with a clean empty state; saved-view persistence lands
  // in a later phase. Tokens only — dark + light both resolve.
  import TasksEmptyState from "$lib/components/tasks/TasksEmptyState.svelte";
  import LayersIcon from "@lucide/svelte/icons/layers";
</script>

<div class="flex h-full w-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-6 py-4">
    <h1 class="text-base font-semibold text-content">Views</h1>
  </header>
  <div class="min-h-0 flex-1">
    <TasksEmptyState
      icon={LayersIcon}
      heading="Save custom views for your project"
      description="Views are saved filters that help you quickly access the information you use most. Collaborate effortlessly as teammates share and tailor views to their specific needs."
    />
  </div>
</div>
