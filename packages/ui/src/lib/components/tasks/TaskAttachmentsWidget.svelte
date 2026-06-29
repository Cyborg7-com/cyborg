<script lang="ts">
  // The "Attachments" widget of the work-item detail body — our own Svelte 5
  // reimplementation of Plane's attachments group (STRUCTURE + UX + colorimetry,
  // NOT a port of Plane's React). It lists a task's file attachments and exposes
  // a dropzone / file-picker that uploads the bytes to S3 through the repo's
  // EXISTING presign path (client.uploadAsset → /api/assets/presign → S3 PUT).
  //
  // Persistence is real: the list reads via client.fetchTaskAttachments when the
  // task opens; an upload presigns + PUTs the bytes (uploadAsset) and then calls
  // client.addTaskAttachment(task.id, { key, url, name, size }) to persist the
  // row, splicing the server's returned row into the list; removing one calls
  // client.removeTaskAttachment(id). Each RPC keys off task.id / attachment id;
  // the relay resolves the task→project and gates visibility. A failed upload or
  // an unreachable S3 surfaces a clean toast and never throws into the render.
  // Token-only (lib/tasks/ui.ts): dark + light both resolve, zero raw colors.
  import { client } from "$lib/state/client.js";
  import { toast } from "svelte-sonner";
  import Collapsible from "$lib/components/tasks/Collapsible.svelte";
  import PaperclipIcon from "@lucide/svelte/icons/paperclip";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import {
    attachmentRow,
    attachmentIcon,
    attachmentBody,
    attachmentName,
    attachmentMeta,
    attachmentActions,
    attachmentActionBtn,
    attachmentAdd,
    collapsibleAddBtn,
  } from "$lib/tasks/ui.js";
  import type { Task, TaskAttachment } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let { task }: { task: Task } = $props();

  // The persisted task attachments for the active task. Loaded by the effect
  // below and mutated against the server's returned row on add / remove.
  let attachments = $state<TaskAttachment[]>([]);
  let uploading = $state(false);
  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  // Re-fetch whenever the active task changes; tolerate a failed fetch by leaving
  // the list empty (honest empty state, no crash). The cancel token guards a
  // stale response from a previous task landing after a fast switch.
  $effect(() => {
    const id = task.id;
    let cancelled = false;
    client
      .fetchTaskAttachments(id)
      .then((rows) => {
        if (!cancelled) attachments = rows;
      })
      .catch(() => {
        if (!cancelled) attachments = [];
      });
    return () => {
      cancelled = true;
    };
  });

  // Human-readable size for the meta line (KB / MB), never a bare byte count.
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Upload each picked/dropped file's bytes through the repo's presign path
  // (uploadAsset → /api/assets/presign → S3 PUT), then persist the row via
  // addTaskAttachment and splice the server's returned row into the list. A
  // failed upload (e.g. S3 unreachable) surfaces a toast and never throws into
  // the render; rows already persisted in the loop are kept.
  async function upload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || uploading) return;
    uploading = true;
    try {
      for (const file of Array.from(files)) {
        const { publicUrl, key } = await client.uploadAsset(file, "task-attachments");
        const attachment = await client.addTaskAttachment(task.id, {
          key,
          url: publicUrl,
          name: file.name,
          size: file.size,
          contentType: file.type || null,
        });
        attachments = [...attachments, attachment];
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the file");
    } finally {
      uploading = false;
    }
  }

  // Remove the attachment optimistically; restore it and toast on failure.
  async function remove(id: string): Promise<void> {
    const prev = attachments;
    attachments = attachments.filter((a) => a.id !== id);
    try {
      await client.removeTaskAttachment(id);
    } catch (err) {
      attachments = prev;
      toast.error(err instanceof Error ? err.message : "Couldn't remove the attachment");
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    void upload(e.dataTransfer?.files ?? null);
  }
</script>

<Collapsible title="Attachments" count={attachments.length}>
  {#snippet actions()}
    <button
      type="button"
      title="Upload file"
      aria-label="Upload file"
      onclick={() => fileInput?.click()}
      class={collapsibleAddBtn}
    >
      <UploadIcon class="size-3.5" />
    </button>
  {/snippet}

  {#snippet children()}
    <div class="flex flex-col gap-1.5">
      {#each attachments as att (att.id)}
        <div class={attachmentRow}>
          <span class={attachmentIcon}>
            <PaperclipIcon class="size-4" />
          </span>
          <div class={attachmentBody}>
            <span class={attachmentName}>{att.name}</span>
            <span class={attachmentMeta}>{formatSize(att.size)}</span>
          </div>
          <div class={attachmentActions}>
            <a
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open attachment"
              aria-label="Open attachment"
              class={attachmentActionBtn}
            >
              <ExternalLinkIcon class="size-3.5" />
            </a>
            <button
              type="button"
              title="Remove attachment"
              aria-label="Remove attachment"
              onclick={() => remove(att.id)}
              class={attachmentActionBtn}
            >
              <Trash2Icon class="size-3.5" />
            </button>
          </div>
        </div>
      {/each}

      <!-- Hidden native picker driven by the dropzone + header action. -->
      <input
        bind:this={fileInput}
        type="file"
        multiple
        class="hidden"
        onchange={(e) => {
          upload(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />

      <!-- The dropzone (Plane's upload affordance): click to pick, or drop files. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        role="button"
        tabindex="0"
        onclick={() => fileInput?.click()}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput?.click();
          }
        }}
        ondragover={(e) => {
          e.preventDefault();
          dragOver = true;
        }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
        class={cn(attachmentAdd, "cursor-pointer", dragOver && "border-accent bg-hover-gray text-content")}
      >
        <UploadIcon class="size-3.5" />
        {#if uploading}
          Uploading…
        {:else}
          Drop files or click to upload
        {/if}
      </div>
    </div>
  {/snippet}
</Collapsible>
