<script lang="ts">
  /**
   * iOS-style 6-box OTP input (mobile login, P1 redesign). Presentation-only
   * wrapper around a single code string: the parent binds `value` to the SAME
   * state variable the desktop single-input flow uses, so verify/resend logic
   * is untouched.
   *
   * Behaviors (QA "P1 login"): auto-advance on digit entry, backspace on an
   * empty box moves back and clears the previous digit, a full-code paste
   * fills all boxes, non-numeric input is stripped, and the first box carries
   * `autocomplete="one-time-code"` so iOS offers the SMS/mail code QuickType
   * suggestion. That suggestion (and some password managers) inserts the WHOLE
   * code into the focused input, so boxes have no maxlength — multi-char
   * inserts are redistributed across the boxes in handleInput instead.
   */
  const LENGTH = 6;

  let { value = $bindable("") }: { value?: string } = $props();

  // Per-box digits are the source of truth while typing; `value` is the joined
  // string handed back to the parent. The effect below only re-derives the
  // boxes when the parent changes `value` externally (e.g. clearing the code
  // after a resend), never while the two are already in sync.
  let digits = $state<string[]>(Array.from({ length: LENGTH }, () => ""));
  const inputs: Array<HTMLInputElement | null> = Array.from({ length: LENGTH }, () => null);

  $effect(() => {
    const external = value;
    if (digits.join("") === external) return;
    const clean = external.replace(/\D/g, "").slice(0, LENGTH);
    digits = Array.from({ length: LENGTH }, (_, i) => clean[i] ?? "");
  });

  function commit(): void {
    value = digits.join("");
  }

  function focusBox(i: number): void {
    const el = inputs[i];
    if (!el) return;
    el.focus();
    // Select so typing on an already-filled box replaces its digit instead of
    // appending a second character next to it.
    el.select();
  }

  function fillFrom(start: number, clean: string): void {
    for (let k = 0; k < clean.length && start + k < LENGTH; k++) {
      digits[start + k] = clean[k];
    }
    commit();
    focusBox(Math.min(start + clean.length, LENGTH - 1));
  }

  function handleInput(i: number, e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    const clean = el.value.replace(/\D/g, "");
    if (clean.length === 0) {
      // Cleared (backspace on a filled box) or non-numeric input: reject.
      digits[i] = "";
      el.value = "";
      commit();
      return;
    }
    if (clean.length === 1) {
      digits[i] = clean;
      el.value = clean;
      commit();
      if (i < LENGTH - 1) focusBox(i + 1);
      return;
    }
    // Multi-char insert: paste fallback or the iOS one-time-code suggestion
    // (which types the whole code into the focused box). A full code always
    // fills from the first box; shorter fragments fill from the current one.
    fillFrom(clean.length >= LENGTH ? 0 : i, clean.slice(0, LENGTH));
    // Svelte won't rewrite the DOM value when the rendered digit is unchanged,
    // so undo the raw multi-char text in this box manually.
    el.value = digits[i];
  }

  function handlePaste(i: number, e: ClipboardEvent): void {
    const text = e.clipboardData?.getData("text") ?? "";
    const clean = text.replace(/\D/g, "").slice(0, LENGTH);
    if (!clean) return;
    e.preventDefault();
    fillFrom(clean.length >= LENGTH ? 0 : i, clean);
  }

  function handleKeydown(i: number, e: KeyboardEvent): void {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      e.preventDefault();
      digits[i - 1] = "";
      commit();
      focusBox(i - 1);
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === "ArrowRight" && i < LENGTH - 1) {
      e.preventDefault();
      focusBox(i + 1);
    }
  }
</script>

<div class="flex justify-between gap-2" role="group" aria-label="Verification code">
  {#each digits as digit, i (i)}
    <input
      bind:this={inputs[i]}
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete={i === 0 ? "one-time-code" : "off"}
      autocapitalize="off"
      spellcheck="false"
      aria-label={`Digit ${i + 1}`}
      value={digit}
      oninput={(e) => handleInput(i, e)}
      onpaste={(e) => handlePaste(i, e)}
      onkeydown={(e) => handleKeydown(i, e)}
      onfocus={(e) => e.currentTarget.select()}
      class="h-[48px] w-[48px] rounded-[12px] border border-edge bg-surface-alt text-center text-[22px] font-semibold text-content caret-accent outline-none transition-colors focus:border-accent"
    />
  {/each}
</div>
