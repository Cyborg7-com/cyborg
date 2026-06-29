<script lang="ts">
  import { cn } from "$lib/utils.js";

  let { size = 20, class: className = "" }: { size?: number; class?: string } = $props();
</script>

<svg class={cn("shrink-0", className)} width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M4.88301 10.0669C3.57584 2.48846 8.33767 2.55071 10.7186 2.36397L10.6719 18.3457C7.12386 18.6569 6.00343 14.9066 5.55215 13.7395C4.47841 14.0507 4.27611 11.7943 4.12049 10.7516C3.9965 9.92092 4.60289 9.8802 4.88301 10.0669Z" stroke="currentColor"/>
  <rect x="12.3681" y="2.5974" width="1.30717" height="15.4682" rx="0.653585" fill="currentColor"/>
  <rect x="15.2314" y="4.80713" width="1.30717" height="11.0798" rx="0.653585" fill="currentColor"/>
</svg>
