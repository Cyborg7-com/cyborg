import { CyborgClient } from "../ws-client.js";

// The shared WS/HTTP client singleton, in its own leaf module so utilities like
// push/web-push can use it WITHOUT pulling in the large app-state module.
// Previously the singleton lived in app.svelte.ts and web-push imported it from
// there, while app.svelte.ts lazy-imported web-push — an import cycle
// (app.svelte.ts and web-push depending on each other). app.svelte.ts now
// re-exports this binding, so existing consumers are unaffected.
export const client = new CyborgClient();
