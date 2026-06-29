<script lang="ts">
  // TasksEmptyState — the Plane-faithful DESIGNED empty state for the Tasks
  // surfaces (Cycles / Modules / Views / Pages / Work Items). A literal fork of
  // Plane's EmptyStateDetailed (propel detailed-empty-state.tsx): a vertically +
  // horizontally CENTERED block in the content area whose anatomy, top-to-bottom,
  // is illustration -> heading -> description -> CTA. Plane's inner content column
  // is left-aligned (text-left) with a 25rem cap and a fixed rhythm:
  //   gap-6 between the illustration and the text/CTA column,
  //   gap-4 between the text block and the CTA,
  //   gap-2 between the heading and the description.
  // Plane's illustration is a themed inline SVG constrained to max-w-40 (160px);
  // we stand in a large lucide GLYPH (per-view) in that slot, sized + quieted to
  // read as the illustration without inventing artwork. The heading maps to
  // Plane's text-16/leading-7 font-semibold text-primary, the description to
  // text-13/leading-5 text-tertiary, and the CTA to Plane's primary Button.
  //
  // Token-only — every class resolves through an app.css semantic token so dark +
  // light both work. The empty-state classes live HERE (not in tasks/ui.ts) by
  // design, so the shared Tasks look file stays owned by its own team.
  import type { Component } from "svelte";

  let {
    icon,
    heading,
    description,
    ctaLabel,
    onCta,
  }: {
    // A lucide-svelte icon component (e.g. `import X from "@lucide/svelte/icons/x"`)
    // rendered as the illustration glyph. Sized + colored by this component.
    icon: Component<{ class?: string }>;
    heading: string;
    description: string;
    // Optional primary call-to-action. Both must be present to render the button
    // (a no-CTA empty state — e.g. the filtered / no-results variant — omits them).
    ctaLabel?: string;
    onCta?: () => void;
  } = $props();

  const Icon = $derived(icon);
</script>

<!-- Outer: centers the whole block both axes in the available content area
     (Plane detailed-empty-state.tsx:30 `flex size-full items-center justify-center`). -->
<div class="flex size-full items-center justify-center px-6 py-10">
  <!-- Inner content column: left-aligned, 25rem cap, gap-6 illustration<->text/CTA
       (Plane detailed-empty-state.tsx:31-39). -->
  <div class="flex w-full max-w-[25rem] flex-col gap-6 text-left">
    <!-- ILLUSTRATION slot — Plane wraps its themed SVG in `flex max-w-40 items-center`
         (max-w 10rem). We sit a large, quiet glyph in that slot. -->
    <div class="flex max-w-40 items-center">
      <span
        class="grid size-16 place-items-center rounded-xl border border-edge bg-surface-alt text-content-muted"
      >
        <Icon class="size-8" />
      </span>
    </div>

    <!-- TEXT + CTA column: gap-4 between the text block and the buttons
         (Plane detailed-empty-state.tsx:46-68). -->
    <div class="flex flex-col gap-4">
      <!-- Title + description grouped, gap-2 (Plane detailed-empty-state.tsx:48). -->
      <div class="flex flex-col gap-2">
        <!-- HEADING — Plane text-16/leading-7 font-semibold text-primary. -->
        <h3 class="text-base font-semibold leading-7 text-content">{heading}</h3>
        <!-- DESCRIPTION — Plane text-13/leading-5 text-tertiary. -->
        <p class="text-[13px] leading-5 text-content-muted">{description}</p>
      </div>

      {#if ctaLabel && onCta}
        <!-- CTA — Plane's primary Button (bg accent, on-accent text). Self-contained
             empty-state geometry; mirrors the Tasks btnPrimary shape via tokens. -->
        <div class="flex">
          <button
            type="button"
            onclick={onCta}
            class="inline-flex h-8 items-center rounded-md bg-accent px-4 text-[13px]
              font-medium text-[color:var(--brand-contrast)] transition-colors
              hover:bg-accent-hover"
          >
            {ctaLabel}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
