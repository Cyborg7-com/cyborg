<script lang="ts">
  import { goto } from "$app/navigation";
  import { authState, getSavedSession } from "$lib/state/app.svelte.js";
  import Splash from "$lib/components/Splash.svelte";

  $effect(() => {
    // A SAVED SESSION means we're going to restore + land in a workspace — route
    // straight to /workspace (which restores + auto-enters under the splash)
    // instead of flashing /login while auth is still false for the first beat.
    // The actual cold-start retry + escape hatch ("taking longer than usual" →
    // "Log in again") lives in /workspace, so this bare <Splash/> is only ever a
    // single redirect frame — the single hatch stays in one place.
    if (authState.authenticated || getSavedSession()) {
      goto("/workspace");
    } else {
      goto("/login");
    }
  });
</script>

<Splash />
