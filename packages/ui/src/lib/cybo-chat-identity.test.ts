import { describe, expect, it } from "vitest";
import { resolveCyboChatIdentity, sessionCyboIdentity } from "./cybo-chat-identity.js";

const RICK = { id: "cybo-1", name: "Rickmaster", avatar: "https://cdn.x/rick.png" };

describe("resolveCyboChatIdentity", () => {
  // Artifact (b): identity from FRAME 0 — before the agents-list row settles,
  // the ?cybo= navigation hint alone yields the cybo's photo + name, never the
  // Cyborg/bot fallback (isCybo gates those out in the view).
  it("hinted cybo alone (no agent row yet) resolves photo + name", () => {
    const id = resolveCyboChatIdentity({ agent: null, hintedCybo: RICK });
    expect(id).toEqual({
      name: "Rickmaster",
      image: "https://cdn.x/rick.png",
      emoji: null,
      isCybo: true,
    });
  });

  it("server-denormalized row wins over the roster", () => {
    const id = resolveCyboChatIdentity({
      agent: { cyboId: "cybo-1", cyboName: "Rick (server)", cyboAvatar: "https://cdn.x/srv.png" },
      rosterCybo: RICK,
    });
    expect(id.name).toBe("Rick (server)");
    expect(id.image).toBe("https://cdn.x/srv.png");
  });

  it("roster fills the gaps when the row has cyboId but no denormalized fields", () => {
    const id = resolveCyboChatIdentity({ agent: { cyboId: "cybo-1" }, rosterCybo: RICK });
    expect(id).toEqual({
      name: "Rickmaster",
      image: "https://cdn.x/rick.png",
      emoji: null,
      isCybo: true,
    });
  });

  // The old code DROPPED emoji avatars (regex → null → Cyborg logo). They must
  // surface as `emoji` so the view renders the emoji itself.
  it("emoji avatars resolve as emoji, not dropped", () => {
    const id = resolveCyboChatIdentity({ hintedCybo: { ...RICK, avatar: "🤖" } });
    expect(id.emoji).toBe("🤖");
    expect(id.image).toBeNull();
    expect(id.name).toBe("Rickmaster");
  });

  it("a cybo with NO avatar still carries its name (initials placeholder), isCybo stays true", () => {
    const id = resolveCyboChatIdentity({ hintedCybo: { ...RICK, avatar: null } });
    expect(id).toEqual({ name: "Rickmaster", image: null, emoji: null, isCybo: true });
  });

  it("non-cybo agents resolve isCybo=false (provider identity is the caller's business)", () => {
    const id = resolveCyboChatIdentity({ agent: { provider: "claude" } });
    expect(id).toEqual({ name: null, image: null, emoji: null, isCybo: false });
  });

  it("any cybo signal on the row marks the session as cybo even with zero lookups", () => {
    expect(resolveCyboChatIdentity({ agent: { cyboName: "Ghosty" } }).isCybo).toBe(true);
    expect(resolveCyboChatIdentity({ agent: { cyboId: "x" } }).isCybo).toBe(true);
  });
});

// Stale/failed sessions (the sidebar "Agent sessions" rows): created before
// identity denorm existed, or whose spawn died before any agent-state sync.
// Identity must resolve from the client ROSTER — photo + name, never the
// Cyborg/bot placeholders.
describe("sessionCyboIdentity (stale/failed session rows)", () => {
  it("ARTIFACT: a cybo session with NO agent-state identity resolves the roster photo + name", () => {
    // The broken-session shape: row has only provider + cyboId (no cyboName /
    // cyboAvatar denorm — pre-denorm daemon or spawn died before sync).
    const stale = { provider: "pi", cyboId: "cybo-1" };
    const id = sessionCyboIdentity(stale, [RICK]);
    expect(id).toEqual({
      name: "Rickmaster",
      image: "https://cdn.x/rick.png",
      emoji: null,
      isCybo: true, // gates the Cyborg/bot branches off in every session list
    });
  });

  it("roster miss on a cybo session still keeps isCybo=true (initials of any known name, not bot)", () => {
    const id = sessionCyboIdentity({ provider: "pi", cyboId: "gone", cyboName: "Ghosty" }, []);
    expect(id.isCybo).toBe(true);
    expect(id.name).toBe("Ghosty");
  });

  it("emoji-avatar cybo sessions surface the emoji (the old list helpers dropped it)", () => {
    const id = sessionCyboIdentity({ cyboId: "cybo-1" }, [{ ...RICK, avatar: "🦊" }]);
    expect(id.emoji).toBe("🦊");
  });

  it("non-cybo sessions are untouched (provider identity)", () => {
    expect(sessionCyboIdentity({ provider: "claude" }, [RICK]).isCybo).toBe(false);
  });
});
