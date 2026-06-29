<script lang="ts">
  // The "Links" widget of the work-item detail body — our own Svelte 5
  // reimplementation of Plane's links group (STRUCTURE + UX + colorimetry, NOT a
  // port of Plane's React). It lists a task's external links and exposes an
  // "Add link" inline form (URL + optional title).
  //
  // Persistence is real: the list reads via client.fetchTaskLinks when the task
  // opens, adding a link calls client.addTaskLink (and splices the returned row
  // into the list), and removing one calls client.removeTaskLink. Each RPC keys
  // off task.id / link id; the relay resolves the task→project and gates
  // visibility. Failures surface a toast and never throw into the render.
  // Token-only (lib/tasks/ui.ts): dark + light both resolve, zero raw colors.
  import { client } from "$lib/state/client.js";
  import { toast } from "svelte-sonner";
  import Collapsible from "$lib/components/tasks/Collapsible.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import LinkIcon from "@lucide/svelte/icons/link";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import {
    attachmentRow,
    attachmentIcon,
    attachmentBody,
    attachmentName,
    attachmentLink,
    attachmentMeta,
    attachmentActions,
    attachmentActionBtn,
    attachmentAdd,
    collapsibleAddBtn,
  } from "$lib/tasks/ui.js";
  import type { Task, TaskLink } from "$lib/core/types.js";

  let { task }: { task: Task } = $props();

  // The persisted task links for the active task. Loaded by the effect below and
  // mutated optimistically on add/remove against the server's returned row.
  let links = $state<TaskLink[]>([]);

  // Re-fetch whenever the active task changes; tolerate a failed fetch by leaving
  // the list empty (honest empty state, no crash). The cancel token guards a
  // stale response from a previous task landing after a fast switch.
  $effect(() => {
    const id = task.id;
    let cancelled = false;
    client
      .fetchTaskLinks(id)
      .then((rows) => {
        if (!cancelled) links = rows;
      })
      .catch(() => {
        if (!cancelled) links = [];
      });
    return () => {
      cancelled = true;
    };
  });

  let adding = $state(false);
  let urlDraft = $state("");
  let titleDraft = $state("");

  // The host shown beside the link title (Plane's secondary meta line). A
  // malformed URL just shows the raw string rather than throwing.
  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // The label for a row: the saved title, or the host as a fallback when the
  // link was saved without one (TaskLink.title is nullable).
  function labelOf(link: TaskLink): string {
    return link.title?.trim() || hostOf(link.url);
  }

  // Normalize a bare "example.com" into a navigable https URL so the row's open
  // action and the host parse both work.
  function normalize(url: string): string {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }

  // Persist the drafted link, then splice the server's returned row into the
  // list. A failed call surfaces a toast and leaves the form open so the input
  // is not lost.
  async function submit(): Promise<void> {
    const url = urlDraft.trim();
    if (!url) return;
    const href = normalize(url);
    const title = titleDraft.trim();
    try {
      const link = await client.addTaskLink(task.id, {
        url: href,
        title: title || null,
      });
      links = [...links, link];
      urlDraft = "";
      titleDraft = "";
      adding = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add the link");
    }
  }

  // Remove the link optimistically; restore it and toast on failure.
  async function remove(id: string): Promise<void> {
    const prev = links;
    links = links.filter((l) => l.id !== id);
    try {
      await client.removeTaskLink(id);
    } catch (err) {
      links = prev;
      toast.error(err instanceof Error ? err.message : "Couldn't remove the link");
    }
  }
</script>

<Collapsible title="Links" count={links.length}>
  {#snippet actions()}
    <button
      type="button"
      title="Add link"
      aria-label="Add link"
      onclick={() => (adding = true)}
      class={collapsibleAddBtn}
    >
      <PlusIcon class="size-3.5" />
    </button>
  {/snippet}

  {#snippet children()}
    <div class="flex flex-col gap-1.5">
      {#each links as link (link.id)}
        <div class={attachmentRow}>
          <span class={attachmentIcon}>
            <LinkIcon class="size-4" />
          </span>
          <div class={attachmentBody}>
            <span class={attachmentName}>{labelOf(link)}</span>
            <span class={attachmentMeta}>{hostOf(link.url)}</span>
          </div>
          <div class={attachmentActions}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open link"
              aria-label="Open link"
              class={attachmentLink + " " + attachmentActionBtn}
            >
              <ExternalLinkIcon class="size-3.5" />
            </a>
            <button
              type="button"
              title="Remove link"
              aria-label="Remove link"
              onclick={() => void remove(link.id)}
              class={attachmentActionBtn}
            >
              <Trash2Icon class="size-3.5" />
            </button>
          </div>
        </div>
      {/each}

      {#if adding}
        <div class="flex flex-col gap-2 rounded-[6px] border border-edge bg-surface-alt p-2">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={urlDraft}
            autofocus
            placeholder="https://…"
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                adding = false;
              }
            }}
            class="rounded-[4px] bg-transparent px-2 py-1 text-[13px] text-content outline-none ring-1 ring-edge focus:ring-accent placeholder:text-content-muted"
          />
          <input
            bind:value={titleDraft}
            placeholder="Title (optional)"
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                adding = false;
              }
            }}
            class="rounded-[4px] bg-transparent px-2 py-1 text-[13px] text-content outline-none ring-1 ring-edge focus:ring-accent placeholder:text-content-muted"
          />
          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              onclick={() => (adding = false)}
              class="rounded-[4px] px-2 py-1 text-[12px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
            >
              Cancel
            </button>
            <button
              type="button"
              onclick={() => void submit()}
              disabled={!urlDraft.trim()}
              class="rounded-[4px] bg-accent px-2.5 py-1 text-[12px] font-medium text-[color:var(--brand-contrast)] transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      {:else}
        <button type="button" onclick={() => (adding = true)} class={attachmentAdd}>
          <PlusIcon class="size-3.5" />
          Add link
        </button>
      {/if}
    </div>
  {/snippet}
</Collapsible>
