// Pure attachment pick-time validation, extracted as a TEST SEAM + de-dup. The
// channel composer (MessageInput.addFiles) and the agent composer's upload state
// machine (composer/attachment-uploads.svelte.ts) BOTH partitioned a picked file
// list into accepted vs oversized-rejected by MAX_ATTACHMENT_BYTES, inline and
// untested. This is the correctness rule (oversize rejection) in one place so it
// can't drift between the two composers and is unit-testable without the DOM.
//
// The actual upload guard (fileToAttachment in media/attachment-upload.ts) still
// re-enforces the same limit on the send path; this pre-pick partition is the
// additive UX that shows an inline "too large" warning BEFORE an upload starts.

/** A file that was rejected at pick time for exceeding the size cap. */
export interface RejectedFile {
  name: string;
  size: number;
}

export interface FilePartition {
  /** Files within the size cap, in input order — these proceed to upload. */
  accepted: File[];
  /** Oversized files (name + size only), in input order — for the inline warning. */
  rejected: RejectedFile[];
}

/**
 * Split a picked/pasted/dropped file list into accepted (size ≤ maxBytes) and
 * rejected (size > maxBytes) buckets, preserving input order. PURE — `maxBytes`
 * is passed in (callers supply MAX_ATTACHMENT_BYTES) so this module pulls in no
 * heavy deps and the rule is testable at any threshold.
 */
export function partitionFilesBySize(files: FileList | File[], maxBytes: number): FilePartition {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of Array.from(files)) {
    if (file.size > maxBytes) rejected.push({ name: file.name, size: file.size });
    else accepted.push(file);
  }
  return { accepted, rejected };
}
