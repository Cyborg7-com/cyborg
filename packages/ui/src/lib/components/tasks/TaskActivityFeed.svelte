<script lang="ts">
  // The "Activity" feed of the work-item detail body — our own Svelte 5
  // reimplementation of Plane's activity tab (STRUCTURE + UX + colorimetry, NOT a
  // port of Plane's React). It renders a task's history as a TIMELINE: each row
  // is an actor avatar + a verb phrase (created / changed <field> from <old> to
  // <new>) or a COMMENT (commentHtml rendered as rich text), plus a relative
  // timestamp. Below the timeline a comment COMPOSER reuses TaskDescriptionEditor
  // so writing a comment matches writing the description.
  //
  // PENDING-SERVER on two seams:
  //   • client.fetchTaskActivity's relay handler lands later — we render the rows
  //     when it returns them and tolerate an empty/failed fetch with an honest
  //     "created"/"updated" metadata fallback (no crash).
  //   • there is no add-comment RPC yet (a comment is an activity row with
  //     field=comment); the composer's submit is a clearly-marked TODO seam that
  //     optimistically shows the new comment for the session.
  // Token-only (lib/tasks/ui.ts): dark + light both resolve, zero raw colors.
  import { client } from "$lib/state/client.js";
  import { toast } from "svelte-sonner";
  import Avatar from "$lib/components/Avatar.svelte";
  import MessageRenderer from "$lib/components/message/MessageRenderer.svelte";
  import TaskDescriptionEditor from "$lib/components/tasks/TaskDescriptionEditor.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { resolveMemberName } from "$lib/tasks/detail.js";
  import { btnPrimary } from "$lib/tasks/ui.js";
  import { uid } from "$lib/tasks/uid.js";
  import type { Task, TaskActivity } from "$lib/core/types.js";

  let {
    task,
    pools,
    workspaceId,
  }: {
    task: Task;
    pools: AssigneePools;
    workspaceId: string;
  } = $props();

  // ── Feed fetch ───────────────────────────────────────────────────────────
  // Re-fetch whenever the active task changes; tolerate the PENDING-SERVER case
  // by falling back to the created/updated metadata in the render below.
  let activity = $state<TaskActivity[]>([]);
  let loaded = $state(false);
  $effect(() => {
    const id = task.id;
    loaded = false;
    let cancelled = false;
    client
      .fetchTaskActivity(id)
      .then((rows) => {
        if (!cancelled) activity = rows;
      })
      .catch(() => {
        if (!cancelled) activity = [];
      })
      .finally(() => {
        if (!cancelled) loaded = true;
      });
    return () => {
      cancelled = true;
    };
  });

  function formatDateTime(ts: number | null | undefined): string {
    if (!ts) return "—";
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // A one-line verb phrase for an attribute-change row: "created this work item",
  // "set <field> to <new>", "changed <field> from <old> to <new>", or a neutral
  // "updated this work item" when the row carries no field. Defensive against a
  // partial row so an unknown shape still reads sensibly.
  function verbPhrase(a: TaskActivity): string {
    if (a.verb === "created") return "created this work item";
    if (!a.field) return "updated this work item";
    if (a.oldValue && a.newValue) return `changed ${a.field} from ${a.oldValue} to ${a.newValue}`;
    if (a.newValue) return `set ${a.field} to ${a.newValue}`;
    if (a.oldValue) return `cleared ${a.field}`;
    return `changed ${a.field}`;
  }

  // ── Comment composer ───────────────────────────────────────────────────────
  // A comment is an activity row with field=comment. The add-comment RPC is
  // PENDING-SERVER, so the composer optimistically prepends the comment for the
  // session and the submit is a TODO seam.
  let commentDraft = $state("");
  let editingComment = $state(false);
  let posting = $state(false);

  async function postComment(): Promise<void> {
    const html = commentDraft.trim();
    if (!html || posting) return;
    posting = true;
    try {
      // ── PENDING-SERVER SEAM ──────────────────────────────────────────────────
      // TODO(tasks-comment-rpc): call `client.createTaskComment(workspaceId,
      // task.id, html)` and let the activity broadcast refresh the feed. Until
      // that RPC exists we optimistically append the comment row for the session.
      void workspaceId;
      const now = Date.now();
      activity = [
        ...activity,
        {
          id: uid(),
          taskId: task.id,
          workspaceId: task.workspaceId,
          actorId: null,
          verb: "updated",
          field: "comment",
          oldValue: null,
          newValue: null,
          commentHtml: html,
          epoch: now,
        },
      ];
      commentDraft = "";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't post the comment");
    } finally {
      posting = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <!-- Timeline -->
  <ul class="flex flex-col gap-3 text-[13px] text-content-dim">
    {#if activity.length > 0}
      {#each activity as a (a.id)}
        {@const actorName = resolveMemberName(a.actorId, pools.members)}
        {@const actor = resolveAssignee(a.actorId, pools)}
        {@const isComment = a.field === "comment" && a.commentHtml != null}
        <li class="flex items-start gap-2.5">
          <Avatar name={actorName || "System"} avatar={actor?.avatarUrl} width={20} fontSize={9} />
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            {#if isComment}
              <span class="text-content">
                <span class="font-medium">{actorName || "System"}</span> commented
                <span class="text-[12px] text-content-muted">· {formatDateTime(a.epoch)}</span>
              </span>
              <div class="rounded-[6px] border border-edge bg-surface-alt px-2.5 py-1.5">
                <MessageRenderer text={a.commentHtml ?? ""} class="text-sm text-content" />
              </div>
            {:else}
              <span class="text-content">
                <span class="font-medium">{actorName || "System"}</span>
                {verbPhrase(a)}
              </span>
              <span class="text-[12px] text-content-muted">{formatDateTime(a.epoch)}</span>
            {/if}
          </div>
        </li>
      {/each}
    {:else}
      <!-- Metadata fallback: who created the task + when, plus an updated row. -->
      {@const creatorName = resolveMemberName(task.createdBy, pools.members)}
      {@const creator = resolveAssignee(task.createdBy, pools)}
      <li class="flex items-start gap-2.5">
        <Avatar name={creatorName || "Unknown"} avatar={creator?.avatarUrl} width={20} fontSize={9} />
        <div class="flex min-w-0 flex-col">
          <span class="text-content">
            {#if creatorName}Created by {creatorName}{:else}Work item created{/if}
          </span>
          <span class="text-[12px] text-content-muted">{formatDateTime(task.createdAt)}</span>
        </div>
      </li>
      {#if task.updatedAt && task.updatedAt !== task.createdAt}
        <li class="flex items-start gap-2.5">
          <span class="mt-1 size-2 shrink-0 rounded-full bg-content-muted/40"></span>
          <div class="flex min-w-0 flex-col">
            <span class="text-content">Last updated</span>
            <span class="text-[12px] text-content-muted">{formatDateTime(task.updatedAt)}</span>
          </div>
        </li>
      {:else if loaded}
        <li class="text-[12px] text-content-muted">No activity since this work item was created.</li>
      {/if}
    {/if}
  </ul>

  <!-- Comment composer: the same markdown editor the description uses. -->
  <div class="flex flex-col gap-2 border-t border-edge/60 pt-3">
    <span class="text-[12px] font-medium text-content-dim">Add a comment</span>
    <TaskDescriptionEditor
      bind:value={commentDraft}
      bind:editing={editingComment}
      placeholder="Leave a comment…"
      onsave={() => {}}
    />
    <div class="flex justify-end">
      <button
        type="button"
        onclick={postComment}
        disabled={!commentDraft.trim() || posting}
        class={btnPrimary}
      >
        Comment
      </button>
    </div>
  </div>
</div>
