<script lang="ts">
  let {
    open = false,
    initialText = "",
    /** iOS native-composer variant (#13 P1): the web composer chrome this modal
     *  normally anchors to is hidden + pointer-events:none on iOS, so render the
     *  modal as a centered position:fixed overlay instead of an absolute popover.
     *  Defaults false → web / desktop behavior byte-for-byte unchanged. */
    ios = false,
    onSave,
    onClose,
  }: {
    open?: boolean;
    initialText?: string;
    ios?: boolean;
    onSave: (text: string, url: string) => void;
    onClose: () => void;
  } = $props();

  let linkText = $state("");
  let linkUrl = $state("");
  let urlInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (open) {
      linkText = initialText;
      linkUrl = "";
      requestAnimationFrame(() => urlInput?.focus());
    }
  });

  function save() {
    if (!linkUrl.trim()) return;
    onSave(linkText.trim() || linkUrl.trim(), linkUrl.trim());
    onClose();
  }
</script>

{#if open && ios}
  <!-- iOS: dim backdrop + centered fixed card (the absolute popover would be
       trapped inside the hidden web chrome). Tap the backdrop to dismiss. -->
  <div
    class="fixed inset-0 z-[var(--z-popover)] flex items-end justify-center px-4 pb-[calc(120px+var(--sab,0px))]"
    style="background-color: rgba(0,0,0,0.45);"
    onpointerdown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    role="presentation"
  >
    <div
      class="w-full max-w-[var(--panel-wider)] rounded-lg p-4 space-y-3"
      style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
    >
      <h4 class="text-[13px] font-semibold text-content">Add link</h4>
      <div>
        <label for="composer-link-text-ios" class="text-[11px] text-content-dim block mb-1">Text</label>
        <input
          id="composer-link-text-ios"
          bind:value={linkText}
          placeholder="Display text"
          class="w-full rounded-md px-2.5 py-1.5 text-[13px] text-content outline-none"
          style="background-color: var(--bg-base); border: 1px solid var(--border);"
        />
      </div>
      <div>
        <label for="composer-link-url-ios" class="text-[11px] text-content-dim block mb-1">Link</label>
        <input
          id="composer-link-url-ios"
          bind:this={urlInput}
          bind:value={linkUrl}
          placeholder="https://"
          class="w-full rounded-md px-2.5 py-1.5 text-[13px] text-content outline-none"
          style="background-color: var(--bg-base); border: 1px solid var(--border);"
          onkeydown={(e) => {
            if (e.key === "Enter" && linkUrl.trim()) { e.preventDefault(); save(); }
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" onclick={onClose} class="px-3 py-1.5 text-[12px] text-content-dim hover:text-content cursor-pointer">Cancel</button>
        <button
          type="button"
          onclick={save}
          disabled={!linkUrl.trim()}
          class="bg-btn-primary-bg px-3 py-1.5 text-[12px] font-semibold text-btn-primary-text rounded-md cursor-pointer hover:bg-btn-primary-hover disabled:opacity-40"
        >Save</button>
      </div>
    </div>
  </div>
{:else if open}
  <div
    class="absolute bottom-full left-0 mb-2 z-50 w-[var(--panel-wide)] rounded-lg p-4 space-y-3"
    style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
  >
    <h4 class="text-[13px] font-semibold text-content">Add link</h4>
    <div>
      <label for="composer-link-text" class="text-[11px] text-content-dim block mb-1">Text</label>
      <input
        id="composer-link-text"
        bind:value={linkText}
        placeholder="Display text"
        class="w-full rounded-md px-2.5 py-1.5 text-[13px] text-content outline-none"
        style="background-color: var(--bg-base); border: 1px solid var(--border);"
      />
    </div>
    <div>
      <label for="composer-link-url" class="text-[11px] text-content-dim block mb-1">Link</label>
      <input
        id="composer-link-url"
        bind:this={urlInput}
        bind:value={linkUrl}
        placeholder="https://"
        class="w-full rounded-md px-2.5 py-1.5 text-[13px] text-content outline-none"
        style="background-color: var(--bg-base); border: 1px solid var(--border);"
        onkeydown={(e) => {
          if (e.key === "Enter" && linkUrl.trim()) { e.preventDefault(); save(); }
          if (e.key === "Escape") onClose();
        }}
      />
    </div>
    <div class="flex justify-end gap-2">
      <button type="button" onclick={onClose} class="px-3 py-1.5 text-[12px] text-content-dim hover:text-content cursor-pointer">Cancel</button>
      <button
        type="button"
        onclick={save}
        disabled={!linkUrl.trim()}
        class="bg-btn-primary-bg px-3 py-1.5 text-[12px] font-semibold text-btn-primary-text rounded-md cursor-pointer hover:bg-btn-primary-hover disabled:opacity-40"
      >Save</button>
    </div>
  </div>
{/if}
