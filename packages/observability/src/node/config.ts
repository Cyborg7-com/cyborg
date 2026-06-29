import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { configureLogfireApi, resolveBaseUrl } from "logfire";
import { getState, OTEL_SCOPE } from "./state.js";

export interface ConfigureObservabilityOptions {
  // Which Cyborg7 surface is reporting (daemon, relay, cli, …). Becomes the
  // `platform:<platform>` global tag.
  platform: string;
  // App version → the `version:<version>` global tag.
  version: string;
  // Logfire deployment environment. Defaults to CYBORG_ENV ?? NODE_ENV ?? "dev".
  environment?: string;
}

function resolveEnvironment(explicit: string | undefined): string {
  return explicit ?? process.env.CYBORG_ENV ?? process.env.NODE_ENV ?? "dev";
}

// Span-processor selection by platform lifetime:
//   - CLI (short-lived): SimpleSpanProcessor — exports each span synchronously and
//     drains on the flush()/shutdown() call before exit. Batching would risk losing
//     spans that never reach the batch interval before the process exits.
//   - daemon / relay / desktop (long-running): BatchSpanProcessor — buffers spans
//     and exports in batches, avoiding the per-span synchronous export bottleneck.
//     It still supports forceFlush(), so flush()/shutdown() drain it on teardown.
// Web doesn't use this Node path. Exported for unit tests (not re-exported from
// the package's public index — it stays an internal selection helper).
export function createSpanProcessor(platform: string, exporter: OTLPTraceExporter): SpanProcessor {
  return platform === "cli" ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);
}

// OTLP exporter failures (bad/expired token, unreachable collector) are reported
// through the OTel global diag channel. Left at the default ConsoleDiagLogger they
// fire on EVERY failed export — a single bad token then produces a continuous
// error storm in the daemon/relay logs. We install a diag logger that SWALLOWS
// exporter export errors and surfaces at most ONE local warning for the lifetime
// of the process, so a misconfiguration degrades to "no telemetry" quietly.
let exporterWarningEmitted = false;

function installExporterErrorSuppression(): void {
  const suppressing: DiagLogger = {
    error(message, ...args) {
      // Export failures come through as `error` on the diag channel. Emit a
      // single human-readable warning, then stay silent.
      if (!exporterWarningEmitted) {
        exporterWarningEmitted = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[observability] Logfire/OTLP export failed; telemetry is degraded. ` +
            `Check LOGFIRE_TOKEN / network. Further export errors are suppressed. (${message})`,
          ...args,
        );
      }
    },
    warn() {},
    info() {},
    debug() {},
    verbose() {},
  };
  // ALL — so nothing routes to the noisy default ConsoleDiagLogger; our logger
  // gates everything down to the single warning above.
  diag.setLogger(suppressing, DiagLogLevel.ALL);
}

/**
 * Idempotent bootstrap for Cyborg7 observability. Call once at process startup
 * (daemon, relay, CLI).
 *
 * When `LOGFIRE_TOKEN` is ABSENT this is a real no-op: every other API in this
 * package becomes a no-op too. That is intentional — it keeps end-user `npm
 * install`s of Cyborg7 packages silent (no telemetry, no errors, no deps spun up).
 *
 * Ported nearly verbatim from v1's `lambda/audit-evaluator/src/instrumentation.ts`
 * (token-gated NodeTracerProvider → SimpleSpanProcessor → OTLPTraceExporter with a
 * RAW `Authorization: <token>` header — NO `Bearer` — to `${resolveBaseUrl}/v1/traces`,
 * then `configureLogfireApi({ otelScope })`). Generalized to apply the global tag
 * set (scope/platform/version) and the deployment environment, and to suppress the
 * Logfire/OTel internal noise + the OTLP exporter error storm.
 */
export function configureObservability(options: ConfigureObservabilityOptions): void {
  const state = getState();

  // Module-level guard: idempotent, mirrors the Python `_configured` flag.
  if (state.configured) {
    return;
  }

  const token = process.env.LOGFIRE_TOKEN ?? "";
  const environment = resolveEnvironment(options.environment);
  // Global tags applied to every span/log: the literal scope, the platform, the
  // app version. (Python applied project tags via with_tags; the JS SDK takes tags
  // per call, so we carry them on the shared state and merge them in getScopedLogger.)
  const globalTags = [OTEL_SCOPE, `platform:${options.platform}`, `version:${options.version}`];

  // No token ⇒ disabled. Mark configured (so we don't re-check) but leave every
  // API a no-op. This is the "end-user install stays silent" path.
  if (!token) {
    state.configured = true;
    state.enabled = false;
    state.globalTags = globalTags;
    state.environment = environment;
    state.provider = null;
    return;
  }

  // Swallow exporter export failures BEFORE registering the provider so a bad
  // token can't start an error storm on the very first flush.
  installExporterErrorSuppression();

  const baseUrl = resolveBaseUrl(process.env, undefined, token);

  // Logfire conveys `environment` as the `deployment.environment.name` resource
  // attribute (the JS SDK has no `environment` config knob like Python's
  // logfire.configure(environment=...)). Setting it on the Resource tags every
  // span from this process with the environment, which is what the Logfire UI
  // filters on.
  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/v1/traces`,
    // RAW token — NO `Bearer` prefix. Logfire's ingest expects the bare token.
    headers: { Authorization: token },
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: OTEL_SCOPE,
      "deployment.environment.name": environment,
    }),
    // Short-lived CLI flushes synchronously; long-running platforms batch.
    spanProcessors: [createSpanProcessor(options.platform, exporter)],
  });
  provider.register();

  // Point the Logfire JS API at our single OTel scope. This is also the scope-
  // suppression equivalent of Python's `logfire.suppress_scopes("logfire")`: all
  // Cyborg7 telemetry is emitted under `OTEL_SCOPE`, so Logfire's own internal
  // instrumentation scope is never mixed into our traces.
  configureLogfireApi({ otelScope: OTEL_SCOPE });

  state.configured = true;
  state.enabled = true;
  state.globalTags = globalTags;
  state.environment = environment;
  state.provider = provider;
}
