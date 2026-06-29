<script lang="ts">
  // Two-step provider → model picker (controlled). Replaces the single flattened
  // CombinedModelSelector for cases where the provider must be explicit so every
  // provider — including Pi — is reachable. Stateless: the parent owns the
  // provider/model values and persistence; this just renders the provider Select
  // and the shared searchable ModelCombobox and emits changes. Used by
  // DaemonDetail (slash override) and the channel AI tab.
  import * as Select from "$lib/components/ui/select/index.js";
  import type { ProviderInfo } from "$lib/plugins/agents/types.js";
  import ModelCombobox from "./ModelCombobox.svelte";

  let {
    providers,
    provider = null,
    model = null,
    disabled = false,
    providerPlaceholder = "Provider",
    modelPlaceholder = "Model",
    onProviderChange,
    onModelChange,
  }: {
    /** The daemon's provider catalog (e.g. providerState.forDaemon(daemonId)). */
    providers: ProviderInfo[];
    /** Currently selected provider id (null = none). */
    provider?: string | null;
    /** Currently selected model id (null = none / not yet picked). */
    model?: string | null;
    disabled?: boolean;
    providerPlaceholder?: string;
    modelPlaceholder?: string;
    onProviderChange: (providerId: string) => void;
    onModelChange: (modelId: string) => void | Promise<void>;
  } = $props();

  const selectedProvider = $derived(providers.find((p) => p.id === provider) ?? null);
  const models = $derived(selectedProvider?.models ?? []);
</script>

<div class="flex flex-wrap items-center gap-2">
  <!-- Provider selector — every provider in the catalog (incl. Pi). -->
  <Select.Root
    type="single"
    value={provider ?? undefined}
    onValueChange={(v) => {
      if (v) onProviderChange(v);
    }}
    {disabled}
  >
    <Select.Trigger class="h-8 min-w-[140px] text-[12px]">
      {selectedProvider?.label ?? providerPlaceholder}
    </Select.Trigger>
    <Select.Content>
      {#each providers as p (p.id)}
        <Select.Item value={p.id} label={p.label} disabled={p.models.length === 0}>
          {p.label}{p.available ? "" : " (not installed)"}{p.models.length === 0
            ? " — no models"
            : ""}
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>

  <!-- Model selector — searchable combobox (shared); whole backend/model id for Pi. -->
  <ModelCombobox
    {models}
    value={model}
    providerId={provider}
    disabled={disabled || !provider}
    placeholder={modelPlaceholder}
    onSelect={onModelChange}
  />
</div>
