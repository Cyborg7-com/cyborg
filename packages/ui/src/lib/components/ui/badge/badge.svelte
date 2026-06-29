<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";

	export const badgeVariants = tv({
		base: "h-5 gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap transition-colors focus-visible:ring-[3px] [&>svg]:pointer-events-none",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
				secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
				destructive: "bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
				outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
				ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
				link: "text-primary underline-offset-4 hover:underline",
				// ── Domain pills (#535): one shared home for the hand-rolled pills
				// that drifted across panes + channel. Each FULLY overrides the base box
				// so the rendered pill is PIXEL-IDENTICAL to the hand-rolled span it
				// replaces — the base is a taller/bordered/12px-icon badge, so every
				// variant re-asserts `h-auto` (originals were auto-height from py-0.5),
				// drops the base's 1px transparent border (`border-0`, except `tag`
				// which wants it), and re-states px / rounding / icon size to match. ──
				// "N new" unread pill (Activity): rounded-full px-2 py-0.5 text-[11px] bold.
				mention:
					"h-auto border-0 rounded-full gap-1 px-2 py-0.5 text-[11px] font-bold bg-[var(--activity-mention-bg)] text-[var(--activity-mention-text)]",
				// Pending-permission chip (Home): px-1.5 gap-0.5 text-[10px] bold, 8px
				// icon, warning token (`bg-warning/15`, the "Remote" badge's form — no hex).
				permission:
					"h-auto border-0 rounded-full gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-warning/15 text-warning [&>svg]:size-2!",
				// Derived "needs attention" badges (#591) — same box as `permission`
				// so the agent-row chips line up. Two tones, both via theme tokens:
				//   attentionDone  → finished cleanly (review): positive `online` token.
				//   attentionError → errored (review NOW): `error` token.
				attentionDone:
					"h-auto border-0 rounded-full gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-online/15 text-online [&>svg]:size-2!",
				attentionError:
					"h-auto border-0 rounded-full gap-0.5 px-1.5 py-0.5 text-[10px] font-bold bg-error/15 text-error [&>svg]:size-2!",
				// "ARCHIVED" status tag: px-1.5 py-0.5 text-[10px] bold uppercase tracked.
				archived:
					"h-auto border-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-content/15 text-content-dim",
				// "YOU" self tag — same box as archived, full-strength text.
				you: "h-auto border-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-content/15 text-content",
				// Data-driven kind tag (Audit): rounded-md, keeps the base 1px border +
				// px-2/py-0.5/font-medium; 11px icon; per-kind color via the caller's `style`.
				tag: "h-auto rounded-md gap-1.5 text-[11px] [&>svg]:size-[11px]!",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? "a" : "span"}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
