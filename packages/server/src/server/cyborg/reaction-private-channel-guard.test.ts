import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// IDOR fix (cyborg:reaction): the reaction handler toggled a reaction on a
// client-supplied messageId after only a workspace-role check, letting a member who
// is NOT in a private channel probe/react to its messages. relay-standalone.ts has
// no exports (it boots the server), so this source-scan locks the wiring: the
// reaction case must (1) anchor the message to the asserted workspace and (2) apply
// the private-channel membership check that fetch_thread / fetch_messages use.
const relaySrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "relay-standalone.ts"),
  "utf-8",
);

// Isolate the cyborg:reaction case body so the assertions can't be satisfied by a
// sibling handler elsewhere in the file.
function reactionCaseBody(): string {
  const start = relaySrc.indexOf('case "cyborg:reaction": {');
  expect(start).toBeGreaterThan(-1);
  const next = relaySrc.indexOf('case "cyborg:create_task": {', start);
  expect(next).toBeGreaterThan(start);
  return relaySrc.slice(start, next);
}

describe("cyborg:reaction private-channel guard (source scan)", () => {
  const body = reactionCaseBody();

  it("anchors the target message to the asserted workspace", () => {
    expect(body).toContain("pg.getMessageById(messageId)");
    expect(body).toMatch(/reactMsg\.workspaceId !== workspaceId/);
  });

  it("enforces private-channel membership before toggling the reaction", () => {
    expect(body).toContain("getChannel(reactMsg.channelId)");
    expect(body).toMatch(/is_private[\s\S]*getChannelMemberRole\(reactMsg\.channelId/);
    const guardIdx = body.indexOf("getChannelMemberRole(reactMsg.channelId");
    const writeIdx = body.indexOf("toggleReaction(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(guardIdx);
  });
});
