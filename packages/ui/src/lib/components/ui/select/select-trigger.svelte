<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		size = "default",
		children,
		...restProps
	}: SelectPrimitive.TriggerProps & {
		size?: "sm" | "default";
	} = $props();
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	data-size={size}
	class={cn(
		"border-edge data-placeholder:text-content-muted [&_svg:not([class*='text-'])]:text-content-muted focus:border-edge-light focus:ring-edge/30 flex w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm text-content whitespace-nowrap transition-shadow outline-none focus:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ChevronDownIcon class="size-4 opacity-50" />
</SelectPrimitive.Trigger>
