import { describe, it, expect } from "vitest";
import { generateMcpToken, hashMcpToken, workspaceIdFromToken, newMcpTokenId } from "./token.js";

describe("mcp token", () => {
  it("embeds the workspace id and round-trips it", () => {
    const { raw } = generateMcpToken("ws_abc123");
    expect(raw.startsWith("cybo_mcp_ws_abc123_")).toBe(true);
    expect(workspaceIdFromToken(raw)).toBe("ws_abc123");
  });

  it("hash is stable for the same token and matches generate()", () => {
    const { raw, hash } = generateMcpToken("ws_1");
    expect(hashMcpToken(raw)).toBe(hash);
    expect(hashMcpToken(raw)).toBe(hashMcpToken(raw));
  });

  it("different tokens hash differently", () => {
    const a = generateMcpToken("ws_1");
    const b = generateMcpToken("ws_1");
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("rejects non-cyborg tokens when extracting workspace", () => {
    expect(workspaceIdFromToken("Bearer xyz")).toBeNull();
    expect(workspaceIdFromToken("cybo_mcp_")).toBeNull();
  });

  it("mints unique ids", () => {
    expect(newMcpTokenId()).not.toBe(newMcpTokenId());
    expect(newMcpTokenId().startsWith("mcp_")).toBe(true);
  });
});
