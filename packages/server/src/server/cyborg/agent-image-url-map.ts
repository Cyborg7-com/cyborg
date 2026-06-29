// In-memory local-path → uploaded-S3-URL map for agent images uploaded during
// THIS daemon session (#845 inline render).
//
// Why both this AND the durable row rewrite (sqlite-timeline-store.rewriteImageUrl):
//   - The durable row is rewritten on upload, so a fetch AFTER the agent is gone
//     (daemon restart / agent closed) serves the reachable S3 URL — and the
//     normal user flow (quit+reopen restarts the embedded daemon) hits this path.
//   - But while the agent is STILL LIVE, fetch_agent_timeline serves from
//     AgentManager's IN-MEMORY window (Paseo-owned, holds the original local
//     token, not the rewritten durable row). A soft reload then re-renders the
//     dead local token. So the dispatcher also rewrites served items through this
//     map, which the upload path populates.
//
// Bounded so a long-lived daemon can't grow it without limit; the tail (most
// recent uploads) is what an open session needs.
const MAX_ENTRIES = 500;
const map = new Map<string, string>();

export function recordAgentImageUrl(localPath: string, s3Url: string): void {
  map.set(localPath, s3Url);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// Replace any known local image path with its uploaded S3 URL inside `text`.
// No-op when the map is empty or the text holds no path-like substring.
export function rewriteAgentImageUrls(text: string): string {
  if (map.size === 0 || !text.includes("/")) return text;
  let out = text;
  for (const [localPath, s3Url] of map) {
    if (out.includes(localPath)) out = out.split(localPath).join(s3Url);
  }
  return out;
}

// Test-only: reset the module singleton between cases.
export function __resetAgentImageUrlMap(): void {
  map.clear();
}
