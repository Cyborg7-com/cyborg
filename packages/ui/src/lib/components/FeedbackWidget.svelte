<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    open = false,
    onclose,
  }: {
    open?: boolean;
    onclose?: () => void;
  } = $props();

  let description = $state("");
  let category = $state<"bug" | "feature" | "general">("general");
  let screenshot = $state<string | null>(null);
  let sending = $state(false);
  let sent = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const categories = [
    { id: "bug" as const, label: "Bug", icon: "\u{1f41b}" },
    { id: "feature" as const, label: "Feature", icon: "✨" },
    { id: "general" as const, label: "General", icon: "\u{1f4ac}" },
  ];

  function reset() {
    description = "";
    category = "general";
    screenshot = null;
    sent = false;
  }

  function handleClose() {
    if (sent) reset();
    onclose?.();
  }

  async function handleSend() {
    if (!description.trim()) return;
    sending = true;
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, description, screenshot }),
      });
      if (!res.ok) throw new Error("Failed to send feedback");
      sent = true;
      setTimeout(() => {
        onclose?.();
        reset();
      }, 2000);
    } catch {
      // silent
    }
    sending = false;
  }

  function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      screenshot = reader.result as string;
    });
    reader.readAsDataURL(file);
  }
</script>

{#if open}
  <div
    class="fixed bottom-16 left-[60px] z-[var(--z-elevated-raised)] w-[340px] rounded-xl overflow-hidden shadow-2xl"
    style="background-color: var(--bg-surface); border: 1px solid var(--border);"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--border);">
      <h3 class="text-[15px] font-bold text-white">Send Feedback</h3>
      <button
        type="button"
        onclick={handleClose}
        aria-label="Close"
        class="text-content-muted hover:text-white cursor-pointer transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    {#if sent}
      <!-- Success state -->
      <div class="px-4 py-8 text-center">
        <div
          class="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
          style="background-color: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3);"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M20 6L9 17l-5-5" stroke="var(--c7-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <p class="text-sm text-white font-medium">Thanks for your feedback!</p>
        <p class="text-xs text-content-muted mt-1">We'll review it shortly.</p>
      </div>
    {:else}
      <!-- Form -->
      <div class="px-4 py-4 space-y-4">
        <!-- Category selector -->
        <div class="flex gap-1.5">
          {#each categories as c (c.id)}
            <button
              type="button"
              onclick={() => (category = c.id)}
              class={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer",
                category === c.id
                  ? "text-accent"
                  : "text-content-dim hover:border-edge-light",
              )}
              style={category === c.id
                ? "background-color: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.4);"
                : `background-color: var(--bg-elevated); border: 1px solid var(--border);`}
            >
              <span>{c.icon}</span> {c.label}
            </button>
          {/each}
        </div>

        <!-- Description -->
        <div>
          <label for="feedback-description" class="text-xs text-content-dim mb-1 block">
            Description <span class="text-content-muted">(required)</span>
          </label>
          <textarea
            id="feedback-description"
            bind:value={description}
            placeholder="Describe the issue or share your feedback..."
            rows={4}
            class="w-full rounded-lg px-3 py-2 text-sm text-white placeholder:text-content-muted outline-none resize-none transition-colors"
            style="background-color: var(--bg-elevated); border: 1px solid var(--border);"
            onfocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border-light)"; }}
            onblur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--border)"; }}
          ></textarea>
        </div>

        <!-- Screenshot -->
        <div>
          <input
            bind:this={fileInput}
            type="file"
            accept="image/*"
            class="hidden"
            onchange={handleFile}
          />
          {#if screenshot}
            <div class="relative">
              <img src={screenshot} alt="Screenshot" class="w-full h-24 object-cover rounded-lg" style="border: 1px solid var(--border);" />
              <button
                type="button"
                onclick={() => (screenshot = null)}
                aria-label="Remove screenshot"
                class="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center cursor-pointer"
                style="background-color: var(--bg-surface); border: 1px solid var(--border);"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          {:else}
            <button
              type="button"
              onclick={() => fileInput?.click()}
              class="w-full py-2 rounded-lg text-xs text-content-dim hover:text-white transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              style="border: 1px dashed var(--border);"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2 11l3.5-4.5L8 10l2-2.5L14 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/>
              </svg>
              Add a screenshot
            </button>
          {/if}
        </div>

        <!-- Send button -->
        <button
          type="button"
          onclick={handleSend}
          disabled={!description.trim() || sending}
          class="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-btn-primary-bg text-btn-primary-text hover:bg-btn-primary-hover"
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    {/if}
  </div>
{/if}
