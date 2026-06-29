// Reusable pending-attachment state machine for composers (#579). Wraps the
// shared `fileToAttachment` upload core with the eager-upload + per-chip
// progress/cancel/retry lifecycle that the channel composer pioneered, so the
// agent composer gets identical behavior without duplicating it. Svelte 5 runes
// module — instantiate once per composer with `createAttachmentUploads()`.
import { onDestroy } from "svelte";
import { MAX_ATTACHMENT_BYTES } from "$lib/core/client.js";
import { partitionFilesBySize } from "$lib/composer-attachment-validation.js";
import { fileToAttachment } from "$lib/media/attachment-upload.js";
import type { PendingFile } from "$lib/components/composer/ComposerAttachments.svelte";
import type { Attachment } from "$lib/types.js";

export interface AttachmentUploads {
  /** Live list for <ComposerAttachments files={...} />. */
  readonly files: PendingFile[];
  /** Files rejected at pick time for exceeding the size cap (inline UX). */
  readonly rejected: { name: string; size: number }[];
  /** An eager upload is still in flight — block send until false. */
  readonly anyUploading: boolean;
  /** Anything attached at all (uploaded, uploading, or errored). */
  readonly hasAny: boolean;
  /** The completed Attachment payloads, in order, skipping un-uploaded/errored. */
  readonly uploaded: Attachment[];
  addFiles(list: FileList | File[]): void;
  removeFile(id: string): void;
  retry(id: string): void;
  clear(): void;
}

export function createAttachmentUploads(): AttachmentUploads {
  let pending = $state<PendingFile[]>([]);
  let rejected = $state<{ name: string; size: number }[]>([]);
  // AbortControllers per in-flight upload so removing a chip mid-upload cancels
  // the PUT instead of letting it finish and resurrect the chip.
  const controllers = new Map<string, AbortController>();

  function addFiles(list: FileList | File[]): void {
    // Shared pick-time size partition (composer-attachment-validation.ts) — same
    // oversize rule as the channel composer, so the two can't drift.
    const { accepted, rejected: tooBig } = partitionFilesBySize(list, MAX_ATTACHMENT_BYTES);
    rejected = tooBig;
    if (accepted.length === 0) return;

    const fresh: PendingFile[] = accepted.map((file) => ({
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      uploading: false,
      mimeType: file.type,
      fileName: file.name,
    }));
    pending = [...pending, ...fresh];
    // Eager upload (channel-composer parity): start now, not on send, so sending
    // feels instant and the chip shows spinner → ✓ (or a retry on failure).
    for (const pf of fresh) void uploadOne(pf.id);
  }

  async function uploadOne(id: string): Promise<void> {
    const target = pending.find((f) => f.id === id);
    if (!target?.file) return;
    const file = target.file;
    const controller = new AbortController();
    controllers.set(id, controller);
    pending = pending.map((f) =>
      f.id === id ? { ...f, uploading: true, error: undefined, progress: 0 } : f,
    );
    try {
      const attachment = await fileToAttachment(file, {
        onProgress: (pct) => {
          pending = pending.map((f) => (f.id === id ? { ...f, progress: pct } : f));
        },
        signal: controller.signal,
      });
      pending = pending.map((f) =>
        f.id === id
          ? { ...f, uploading: false, error: undefined, progress: undefined, uploaded: attachment }
          : f,
      );
    } catch (e) {
      // A user-cancelled upload (× during flight) aborts the PUT and removeFile
      // already dropped the chip — don't resurrect it with an error row.
      if (e instanceof Error && e.name === "AbortError") return;
      pending = pending.map((f) =>
        f.id === id
          ? {
              ...f,
              uploading: false,
              progress: undefined,
              error: e instanceof Error ? e.message : "Upload failed",
            }
          : f,
      );
    } finally {
      controllers.delete(id);
    }
  }

  function removeFile(id: string): void {
    const pf = pending.find((f) => f.id === id);
    if (pf?.preview) URL.revokeObjectURL(pf.preview);
    controllers.get(id)?.abort();
    controllers.delete(id);
    pending = pending.filter((f) => f.id !== id);
  }

  function clear(): void {
    for (const pf of pending) {
      if (pf.preview) URL.revokeObjectURL(pf.preview);
      controllers.get(pf.id)?.abort();
    }
    controllers.clear();
    pending = [];
    rejected = [];
  }

  // Instantiated once per composer during component init, so the host
  // component's teardown reaches us: abort any in-flight uploads and revoke the
  // object URLs instead of leaking them when the composer unmounts mid-upload.
  onDestroy(clear);

  return {
    get files() {
      return pending;
    },
    get rejected() {
      return rejected;
    },
    get anyUploading() {
      return pending.some((f) => f.uploading);
    },
    get hasAny() {
      return pending.length > 0;
    },
    get uploaded() {
      return pending.map((f) => f.uploaded).filter((a): a is Attachment => a != null);
    },
    addFiles,
    removeFile,
    retry: (id: string) => void uploadOne(id),
    clear,
  };
}
