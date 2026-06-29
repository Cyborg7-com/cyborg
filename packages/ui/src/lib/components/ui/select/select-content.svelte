<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import SelectScrollUpButton from "./select-scroll-up-button.svelte";
	import SelectScrollDownButton from "./select-scroll-down-button.svelte";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		portalProps,
		children,
		...restProps
	}: SelectPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SelectPrimitive.Portal>>;
	} = $props();
</script>

<SelectPrimitive.Portal {...portalProps}>
	<SelectPrimitive.Content
		bind:ref
		{sideOffset}
		data-slot="select-content"
		class={cn(
			"bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--bits-select-content-available-height) min-w-32 origin-(--bits-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-edge shadow-md",
			className
		)}
		{...restProps}
	>
		<SelectScrollUpButton />
		<SelectPrimitive.Viewport
			class={cn("h-(--bits-select-anchor-height) w-full min-w-(--bits-select-anchor-width) scroll-my-1 p-1")}
		>
			{@render children?.()}
		</SelectPrimitive.Viewport>
		<SelectScrollDownButton />
	</SelectPrimitive.Content>
</SelectPrimitive.Portal>
