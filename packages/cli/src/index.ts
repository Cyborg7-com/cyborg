import { configureObservability } from "@cyborg7/observability/node";
import { runCli } from "./run.js";
import { resolveCliVersion } from "./version.js";

// Token-gated no-op when LOGFIRE_TOKEN is absent. Configure once at startup so
// the with-output error chokepoint can report failures to Logfire.
configureObservability({ platform: "cli", version: resolveCliVersion() });

const exitCode = await runCli(process.argv.slice(2), {
  nodeArgv: [process.argv[0] ?? "node", process.argv[1] ?? "paseo"],
});
process.exitCode = exitCode;
