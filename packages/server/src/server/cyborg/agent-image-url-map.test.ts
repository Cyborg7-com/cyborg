import { beforeEach, describe, expect, test } from "vitest";
import {
  __resetAgentImageUrlMap,
  recordAgentImageUrl,
  rewriteAgentImageUrls,
} from "./agent-image-url-map.js";

// The in-memory map lets the dispatcher rewrite a local image path to its
// uploaded S3 URL while the agent is still LIVE (served from AgentManager's
// in-memory window, which holds the original local token).
describe("agent-image-url-map", () => {
  beforeEach(() => __resetAgentImageUrlMap());

  test("rewrites a recorded local path to its S3 URL inside text", () => {
    recordAgentImageUrl(
      "/var/folders/x/T/paseo-attachments/a.png",
      "https://b.s3.us-east-1.amazonaws.com/agent-images/a.png",
    );
    expect(rewriteAgentImageUrls("see ![p](/var/folders/x/T/paseo-attachments/a.png) ok")).toBe(
      "see ![p](https://b.s3.us-east-1.amazonaws.com/agent-images/a.png) ok",
    );
  });

  test("no-op for an unrecorded path / empty map", () => {
    expect(rewriteAgentImageUrls("![p](/tmp/other.png)")).toBe("![p](/tmp/other.png)");
    recordAgentImageUrl("/a/b.png", "https://b.s3.x.amazonaws.com/b.png");
    expect(rewriteAgentImageUrls("no slashes-ish text")).toBe("no slashes-ish text");
  });

  test("already-rewritten (S3) text is untouched", () => {
    recordAgentImageUrl("/a/b.png", "https://b.s3.x.amazonaws.com/b.png");
    const s3 = "![p](https://b.s3.x.amazonaws.com/b.png)";
    expect(rewriteAgentImageUrls(s3)).toBe(s3);
  });
});
