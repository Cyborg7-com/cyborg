<script module lang="ts">
  import type { AgentPermissionRequest } from "$lib/types.js";

  export interface ParsedQuestionOption {
    label: string;
    description?: string;
  }
  export interface ParsedQuestion {
    // The answer key the server accepts: Claude's AskUserQuestion normalizer
    // (normalizeClaudeAskUserQuestionUpdatedInput) keys answers by the full
    // question text OR the header — we send the header when present, else the text.
    key: string;
    question: string;
    header?: string;
    options: ParsedQuestionOption[];
    multiSelect: boolean;
  }

  function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }
  function asNonEmptyString(v: unknown): string | undefined {
    return typeof v === "string" && v.trim().length > 0 ? v : undefined;
  }

  // Parse the AskUserQuestion tool input (carried on request.input) into a typed,
  // defensively-validated question list. Returns [] when the payload isn't a
  // question-with-options (so callers can fall back to the allow/deny card).
  export function parseAskUserQuestions(request: AgentPermissionRequest): ParsedQuestion[] {
    const input = asRecord(request.input);
    const raw = input && Array.isArray(input.questions) ? input.questions : null;
    if (!raw) return [];
    const out: ParsedQuestion[] = [];
    for (const item of raw) {
      const q = asRecord(item);
      const question = q ? asNonEmptyString(q.question) : undefined;
      if (!q || !question) continue;
      const optionsRaw = Array.isArray(q.options) ? q.options : [];
      const options: ParsedQuestionOption[] = [];
      for (const o of optionsRaw) {
        if (typeof o === "string") {
          const label = asNonEmptyString(o);
          if (label) options.push({ label });
          continue;
        }
        const or = asRecord(o);
        const label = or ? asNonEmptyString(or.label) : undefined;
        if (label) options.push({ label, description: or ? asNonEmptyString(or.description) : undefined });
      }
      if (options.length === 0) continue;
      const header = asNonEmptyString(q.header);
      out.push({
        key: header ?? question,
        question,
        header,
        options,
        multiSelect: q.multiSelect === true,
      });
    }
    return out;
  }

  // True when this permission request is an agent question with selectable options
  // (vs a real tool allow/deny permission). Used to route to this card.
  export function isAskUserQuestion(request: AgentPermissionRequest): boolean {
    return request.kind === "question" && parseAskUserQuestions(request).length > 0;
  }
</script>

<script lang="ts">
  import { respondToPermission } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";

  let {
    agentId,
    request,
  }: {
    agentId: string;
    request: AgentPermissionRequest;
  } = $props();

  const questions = $derived(parseAskUserQuestions(request));
  // Selected option labels per question key (array supports multiSelect).
  let selected = $state<Record<string, string[]>>({});
  let submitted = $state(false);

  // Reset the transient answer state whenever this instance is reused for a
  // DIFFERENT request or agent (Svelte may reuse the component across prop
  // changes). Without this, a prior question's selections/submitted flag would
  // leak into the next one.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track request/agent to reset on change
    [request.id, agentId];
    selected = {};
    submitted = false;
  });

  // A single single-select question answers immediately on click; anything else
  // (multiple questions, or any multiSelect) accumulates and needs Submit.
  const needsSubmitButton = $derived(questions.length > 1 || questions.some((q) => q.multiSelect));
  const allAnswered = $derived(questions.every((q) => (selected[q.key] ?? []).length > 0));

  function isSelected(key: string, label: string): boolean {
    return (selected[key] ?? []).includes(label);
  }

  function submit(): void {
    if (submitted || !allAnswered) return;
    submitted = true;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.key] = (selected[q.key] ?? []).join(", ");
    // Map to the AskUserQuestion answer shape the server expects (allow +
    // updatedInput.answers), NOT a tool allow/deny.
    respondToPermission(agentId, request.id, { behavior: "allow", updatedInput: { answers } });
  }

  function choose(q: ParsedQuestion, label: string): void {
    if (submitted) return;
    if (q.multiSelect) {
      const cur = selected[q.key] ?? [];
      selected = {
        ...selected,
        [q.key]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
      return;
    }
    selected = { ...selected, [q.key]: [label] };
    if (!needsSubmitButton) submit();
  }

  function dismiss(): void {
    if (submitted) return;
    submitted = true;
    respondToPermission(agentId, request.id, { behavior: "deny" });
  }
</script>

<div class="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 space-y-3">
  <div class="flex items-start gap-2">
    <span class="text-warning text-sm shrink-0 mt-0.5">?</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-content">{request.title ?? request.name}</div>
      {#if request.description}
        <div class="text-xs text-content-muted mt-0.5">{request.description}</div>
      {/if}
      <div class="text-[10px] text-content-dim mt-1">{request.kind} &middot; {request.provider}</div>
    </div>
  </div>

  {#each questions as q (q.key)}
    <div class="space-y-1.5">
      <div class="text-sm font-medium text-content">{q.header ?? q.question}</div>
      {#if q.header && q.question !== q.header}
        <div class="text-xs text-content-muted">{q.question}</div>
      {/if}
      <div class="flex flex-wrap gap-2">
        {#each q.options as opt (opt.label)}
          <button
            onclick={() => choose(q, opt.label)}
            aria-disabled={submitted}
            title={opt.description}
            class={cn(
              "rounded px-3 py-1 text-xs font-medium border transition-colors",
              isSelected(q.key, opt.label)
                ? "bg-btn-primary-bg text-btn-primary-text border-transparent"
                : "bg-surface-alt text-content border-edge hover:bg-[var(--sidebar-hover)]",
              submitted && "opacity-60 cursor-default",
            )}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    </div>
  {/each}

  <div class="flex items-center gap-2 pt-1">
    {#if needsSubmitButton}
      <button
        onclick={submit}
        disabled={submitted || !allAnswered}
        class="rounded px-3 py-1 text-xs font-medium bg-btn-primary-bg text-btn-primary-text hover:bg-btn-primary-hover transition-colors disabled:opacity-50"
      >
        Submit
      </button>
    {/if}
    <button
      onclick={dismiss}
      disabled={submitted}
      class="rounded px-3 py-1 text-xs font-medium bg-surface-alt text-content border border-edge hover:bg-[var(--sidebar-hover)] transition-colors disabled:opacity-60"
    >
      Dismiss
    </button>
  </div>
</div>
