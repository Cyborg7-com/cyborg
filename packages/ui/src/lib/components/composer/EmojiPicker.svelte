<script lang="ts">
  import { cn } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import { EMOJI_CATEGORIES as CATEGORIES, EMOJI_NAMES } from "$lib/emoji.js";

  let {
    onSelect,
    onClose,
    class: className = "",
  }: {
    onSelect: (emoji: string) => void;
    onClose: () => void;
    class?: string;
  } = $props();

  const FREQ_KEY = "cyborg7_freq_emoji";

  let search = $state("");
  let activeCategory = $state("smileys");
  let searchInputEl: HTMLInputElement | undefined = $state();
  let scrollContainerEl: HTMLDivElement | undefined = $state();
  const sectionEls = new Map<string, HTMLDivElement>();

  function getFrequent(): string[] {
    if (typeof localStorage === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(FREQ_KEY) ?? "[]").slice(0, 24);
    } catch { return []; }
  }

  function trackEmoji(em: string) {
    try {
      const list: string[] = JSON.parse(localStorage.getItem(FREQ_KEY) ?? "[]");
      const updated = [em, ...list.filter((e: string) => e !== em)].slice(0, 32);
      localStorage.setItem(FREQ_KEY, JSON.stringify(updated));
    } catch { /* noop */ }
  }

  $effect(() => {
    searchInputEl?.focus();
  });

  const frequent = $derived(getFrequent());

  const categories = $derived.by(() => {
    return CATEGORIES.map((c) =>
      c.id === "frequent" ? { ...c, emojis: frequent } : c
    ).filter((c) => c.emojis.length > 0);
  });

  const filtered = $derived.by(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    const matches: string[] = [];
    const seen = new Set<string>();
    for (const cat of CATEGORIES) {
      for (const em of cat.emojis) {
        if (seen.has(em)) continue;
        const names = EMOJI_NAMES[em];
        if (names?.some((n) => n.includes(q))) {
          matches.push(em);
          seen.add(em);
        }
      }
    }
    return matches.slice(0, 48);
  });

  function handleSelect(em: string) {
    trackEmoji(em);
    onSelect(em);
  }

  function scrollToCategory(id: string) {
    const el = sectionEls.get(id);
    if (el && scrollContainerEl) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      activeCategory = id;
    }
  }

  function handleScroll() {
    if (!scrollContainerEl || search.trim()) return;
    const containerTop = scrollContainerEl.getBoundingClientRect().top;
    let closest = categories[0]?.id ?? "smileys";
    let minDist = Infinity;
    for (const cat of categories) {
      const el = sectionEls.get(cat.id);
      if (!el) continue;
      const dist = Math.abs(el.getBoundingClientRect().top - containerTop);
      if (dist < minDist) {
        minDist = dist;
        closest = cat.id;
      }
    }
    activeCategory = closest;
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (search) {
        search = "";
      } else {
        onClose();
      }
      e.preventDefault();
    }
  }

  function sectionRef(node: HTMLDivElement, getCatId: () => string) {
    const id = getCatId();
    sectionEls.set(id, node);
    return {
      destroy() { sectionEls.delete(id); }
    };
  }
</script>

<div
  class={cn("flex flex-col overflow-hidden rounded-xl", className)}
  style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow); width: 352px; height: 380px;"
>
  <!-- Category tabs -->
  <div
    class="flex shrink-0 items-center gap-0.5 px-2 py-1.5"
    style="border-bottom: 1px solid var(--dropdown-border);"
  >
    {#each categories as cat (cat.id)}
      <button
        type="button"
        onclick={() => scrollToCategory(cat.id)}
        class="flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors touch-target"
        style="background-color: {activeCategory === cat.id ? 'var(--dropdown-hover)' : 'transparent'};"
        title={cat.label}
      >
        <Emoji emoji={cat.icon} size={18} />
      </button>
    {/each}
  </div>

  <!-- Search -->
  <div class="shrink-0 px-2.5 py-2">
    <input
      bind:this={searchInputEl}
      type="text"
      bind:value={search}
      placeholder="Search all emoji"
      class="h-8 w-full rounded-lg bg-transparent px-2.5 text-[13px] outline-none"
      style="border: 1px solid var(--dropdown-border); color: var(--dropdown-name);"
      onkeydown={handleSearchKeydown}
    />
  </div>

  <!-- Emoji grid -->
  <div
    bind:this={scrollContainerEl}
    class="flex-1 overflow-y-auto px-2 pb-2"
    onscroll={handleScroll}
  >
    {#if filtered}
      <div>
        <div
          class="sticky top-0 z-10 px-1 py-1 text-[11px] font-semibold"
          style="color: var(--dropdown-secondary); background-color: var(--dropdown-bg);"
        >
          Search Results
        </div>
        {#if filtered.length === 0}
          <div class="py-4 text-center text-[13px]" style="color: var(--dropdown-secondary);">
            No emoji found
          </div>
        {:else}
          <div class="grid grid-cols-9 gap-0.5">
            {#each filtered as em (em)}
              <button
                type="button"
                onclick={() => handleSelect(em)}
                class="flex h-8 w-8 cursor-pointer items-center justify-center rounded transition-colors touch-target"
                onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
                onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
              >
                <Emoji emoji={em} size={24} />
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      {#each categories as cat (cat.id)}
        <div use:sectionRef={() => cat.id}>
          <div
            class="sticky top-0 z-10 px-1 py-1 text-[11px] font-semibold"
            style="color: var(--dropdown-secondary); background-color: var(--dropdown-bg);"
          >
            {cat.label}
          </div>
          <div class="grid grid-cols-9 gap-0.5">
            {#each cat.emojis as em (em)}
              <button
                type="button"
                onclick={() => handleSelect(em)}
                class="flex h-8 w-8 cursor-pointer items-center justify-center rounded transition-colors touch-target"
                onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--dropdown-hover)"; }}
                onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
              >
                <Emoji emoji={em} size={24} />
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
