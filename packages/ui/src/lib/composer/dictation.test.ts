import { describe, expect, it } from "vitest";
import {
  foldTranscript,
  getSpeechRecognitionCtor,
  isDictationSupported,
} from "./dictation.svelte.js";

// SpeechRecognition result shape: an array-like of { isFinal, 0: { transcript } }.
const mk = (parts: Array<[string, boolean]>) =>
  parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }));

describe("foldTranscript", () => {
  it("concatenates final and interim segments separately", () => {
    const r = foldTranscript(
      mk([
        ["hello ", true],
        ["world ", true],
        ["maybe", false],
      ]),
    );
    expect(r.final).toBe("hello world ");
    expect(r.interim).toBe("maybe");
  });

  it("empty results → empty strings", () => {
    expect(foldTranscript(mk([]))).toEqual({ final: "", interim: "" });
  });

  it("all interim → final empty", () => {
    expect(foldTranscript(mk([["typing", false]]))).toEqual({ final: "", interim: "typing" });
  });

  it("tolerates a missing alternative without throwing", () => {
    const broken = [
      { isFinal: true } as unknown as { isFinal: boolean; 0: { transcript: string } },
    ];
    expect(foldTranscript(broken)).toEqual({ final: "", interim: "" });
  });
});

describe("support detection (no window in plain-node vitest)", () => {
  it("getSpeechRecognitionCtor → null and isDictationSupported → false", () => {
    // jsdom/node here has no SpeechRecognition → the graceful-fallback path.
    expect(getSpeechRecognitionCtor()).toBeNull();
    expect(isDictationSupported()).toBe(false);
  });
});
