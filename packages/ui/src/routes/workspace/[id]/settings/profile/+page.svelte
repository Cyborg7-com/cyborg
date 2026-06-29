<script lang="ts">
  // S8: mobile-only Profile sub-page hosting the EXISTING ProfileSettings
  // widget (avatar upload + display name + read-only email). A real sub-route
  // (not an in-page stacked view) so the edge-swipe and the header back chevron
  // both pop to /settings via the existing computeBackTarget mapping, and the
  // push/pop transition plays for free. The 44pt "Profile" header bar comes
  // from the settings +layout. Desktop never links here; direct hits bounce to
  // the settings root, where General hosts ProfileSettings inline (same
  // pattern as the channel-details pushed page).
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import ProfileSettings from "$lib/components/settings/ProfileSettings.svelte";

  const basePath = $derived(`/workspace/${page.params.id}/settings`);

  $effect(() => {
    if (!viewportState.isMobile) void goto(basePath, { replaceState: true });
  });
</script>

<div class="px-4 pb-8 pt-2">
  <div class="overflow-hidden rounded-[14px] bg-surface-alt p-[16px]">
    <div class="space-y-4">
      <ProfileSettings />
    </div>
  </div>
</div>
