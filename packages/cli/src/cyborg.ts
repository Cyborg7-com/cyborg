import { configureObservability } from "@cyborg7/observability/node";
import { createCyborgCli } from "./cyborg-cli.js";
import { resolveCliVersion } from "./version.js";

// Token-gated no-op when LOGFIRE_TOKEN is absent. Configure once at startup so
// the with-output error chokepoint can report failures to Logfire.
configureObservability({ platform: "cli", version: resolveCliVersion() });

const program = createCyborgCli();
await program.parseAsync(process.argv);
