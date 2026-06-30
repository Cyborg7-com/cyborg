<script lang="ts">
  // Built-in recipe CONFIGURE detail page — mirrors the GitHub integration detail
  // page shape (back link → header → sections). Renders the recipe's config fields
  // (channel picker(s), cron cadence text + friendly label, number, timezone),
  // seeded from the existing install when re-configuring, else the catalog
  // defaults. Save → enable_recipe (provision/re-provision); Disable → disable_recipe
  // (tear the cybo + schedules down). Token-only styling.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { client, recipesState } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import RecipeIcon from "$lib/components/integrations/RecipeIcon.svelte";
  import { cronToLabel } from "$lib/schedule/recurrence.js";
  import {
    recipeById,
    defaultRecipeConfig,
    browserTimezone,
  } from "$lib/integrations/recipes-catalog.js";
  import type { Channel } from "$lib/core/types.js";

  const workspaceId = $derived(page.params.id ?? "");
  const recipeId = $derived(page.params.recipeId ?? "");
  const integrationsHref = $derived(`/workspace/${workspaceId}/settings/integrations`);
  const recipe = $derived(recipeById(recipeId));

  // The workspace channels for the channel-picker fields.
  let channels = $state<Channel[]>([]);
  let loadingChannels = $state(true);

  // The form's working config, keyed by the recipe's config keys. All values are
  // edited as strings (channel id, cron, tz) or numbers; coerced on save.
  let form = $state<Record<string, string | number>>({});

  // Whether this recipe already has an active install (drives Save vs the Disable
  // button + the seed source).
  const installed = $derived(recipesState.installed(recipeId));

  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedNote = $state(false);
  let confirmDisable = $state(false);
  let disabling = $state(false);

  // Seed `form` from the install's config (re-configure) or the catalog defaults
  // (fresh enable). Re-seeds whenever the install or recipe changes.
  function seedForm(): void {
    if (!recipe) return;
    const base = defaultRecipeConfig(recipe);
    const existing = installed?.config ?? {};
    // Mutate the $state object in place (clear then set) instead of reassigning
    // the reference, so Svelte's reactivity tracks per-key.
    for (const key of Object.keys(form)) {
      delete form[key];
    }
    for (const field of recipe.configFields) {
      const fromInstall = existing[field.key];
      const fromBase = base[field.key];
      const value = fromInstall ?? fromBase ?? "";
      form[field.key] =
        field.type === "number" ? Number(value) || Number(fromBase) || 0 : String(value);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        channels = await client.listChannels(workspaceId);
      } catch {
        channels = [];
      } finally {
        loadingChannels = false;
      }
    })();
    // Ensure the install list is loaded so `installed` resolves (e.g. on a deep
    // link straight to this page). seedForm runs after via the $effect below.
    void recipesState.load(workspaceId).then(seedForm);
    seedForm();
  });

  function channelName(id: string): string {
    return channels.find((c) => c.id === id)?.name ?? "";
  }

  // Channel fields must be picked before enabling. Other fields carry defaults.
  const channelKeys = $derived(
    (recipe?.configFields ?? []).filter((f) => f.type === "channel").map((f) => f.key),
  );
  const missingChannel = $derived(channelKeys.some((k) => !form[k]));

  async function save(): Promise<void> {
    if (!recipe || saving) return;
    saving = true;
    error = null;
    savedNote = false;
    try {
      // Build the config object with the recipe's keys verbatim. Coerce number
      // fields; fall back the timezone to the browser tz if blanked.
      const config: Record<string, unknown> = {};
      for (const field of recipe.configFields) {
        const raw = form[field.key];
        if (field.type === "number") config[field.key] = Number(raw) || (field.default ?? 0);
        else if (field.type === "timezone") config[field.key] = String(raw) || browserTimezone();
        else config[field.key] = String(raw ?? "");
      }
      await recipesState.enable(workspaceId, recipeId, config);
      savedNote = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to enable this integration";
    } finally {
      saving = false;
    }
  }

  async function disable(): Promise<void> {
    if (disabling) return;
    disabling = true;
    error = null;
    try {
      await recipesState.disable(workspaceId, recipeId);
      confirmDisable = false;
      savedNote = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to disable this integration";
    } finally {
      disabling = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
  <!-- Back link -->
  <a
    href={integrationsHref}
    class="inline-flex items-center gap-1.5 text-[13px] text-content-muted transition-colors hover:text-content"
  >
    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
    Back to integrations
  </a>

  {#if !recipe}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[13px] text-content-muted">
      Unknown integration.
    </p>
  {:else}
    <!-- Header -->
    <header class="flex items-start gap-4">
      <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-content">
        <RecipeIcon name={recipe.icon} size={24} />
      </div>
      <div class="min-w-0">
        <h1 class="flex items-center gap-1.5 text-lg font-semibold text-content">
          {recipe.name}
          {#if installed}
            <svg class="h-4 w-4 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="{recipe.name} enabled">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          {/if}
        </h1>
        <p class="mt-0.5 text-[13px] text-content-muted">
          {recipe.description}
        </p>
      </div>
    </header>

    {#if savedNote}
      <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-success">
        {installed ? "Saved." : "Enabled."} The cybo and its schedules are provisioned in your workspace.
      </p>
    {/if}
    {#if error}
      <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error" role="alert">
        {error}
      </p>
    {/if}

    <!-- Configuration -->
    <section class="space-y-4">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Configuration</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">
          Pick the channels and cadences this automation runs on.
        </p>
      </div>

      {#each recipe.configFields as field (field.key)}
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-content" id={`recipe-${field.key}-label`}>
            {field.label}
          </span>

          {#if field.type === "channel"}
            <Select.Root
              type="single"
              value={String(form[field.key] ?? "")}
              onValueChange={(v) => (form[field.key] = v)}
            >
              <Select.Trigger aria-labelledby={`recipe-${field.key}-label`} disabled={loadingChannels}>
                {#if form[field.key]}
                  #{channelName(String(form[field.key]))}
                {:else}
                  <span class="text-content-muted">
                    {loadingChannels ? "Loading channels…" : "Choose a channel…"}
                  </span>
                {/if}
              </Select.Trigger>
              <Select.Content>
                {#each channels as c (c.id)}
                  <Select.Item value={c.id} label={c.name}>#{c.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {:else if field.type === "number"}
            <Input
              type="number"
              min={field.min}
              value={String(form[field.key] ?? "")}
              oninput={(e) => (form[field.key] = Number(e.currentTarget.value))}
              aria-labelledby={`recipe-${field.key}-label`}
              class="max-w-[12rem]"
            />
          {:else}
            <!-- cron + timezone: a text field prefilled with the default. -->
            <Input
              type="text"
              value={String(form[field.key] ?? "")}
              oninput={(e) => (form[field.key] = e.currentTarget.value)}
              aria-labelledby={`recipe-${field.key}-label`}
              class="font-mono"
            />
            {#if field.type === "cron" && form[field.key]}
              <span class="text-[12px] text-content-dim">{cronToLabel(String(form[field.key]))}</span>
            {/if}
          {/if}

          {#if field.hint}
            <span class="text-[12px] text-content-dim">{field.hint}</span>
          {/if}
        </div>
      {/each}
    </section>

    <!-- Actions -->
    <section class="flex items-center justify-between gap-3 border-t border-edge pt-5">
      <div>
        {#if installed}
          <Button
            size="sm"
            variant="destructive"
            disabled={disabling}
            onclick={() => (confirmDisable = true)}
          >
            Remove integration
          </Button>
        {/if}
      </div>
      <Button size="sm" disabled={saving || missingChannel} onclick={save}>
        {#if saving}
          Saving…
        {:else if installed}
          Save changes
        {:else}
          Enable
        {/if}
      </Button>
    </section>
  {/if}
</div>

<ConfirmDialog
  open={confirmDisable}
  title="Remove integration"
  message={recipe
    ? `Remove ${recipe.name}? This deletes its cybo and stops its schedules. You can enable it again later.`
    : ""}
  confirmLabel="Remove"
  cancelLabel="Cancel"
  destructive
  onconfirm={disable}
  oncancel={() => (confirmDisable = false)}
/>
