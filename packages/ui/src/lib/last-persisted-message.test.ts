import { describe, expect, it } from "vitest";
import { lastPersistedMessage, shouldClearSlashProgress } from "./last-persisted-message.js";
import type { Message } from "./core/types.js";

function msg(id: string, seq: number | undefined, fromType: Message["fromType"]): Message {
  return { id, channelId: "c1", fromId: "u1", fromType, text: id, seq, createdAt: 1 } as Message;
}

// The slash-progress indicator must anchor on / clear against the last REAL
// message — local seq:0 ephemera (slash warn notes, #210 alerts) sort
// pinned-last and would otherwise strand the indicator until their TTL.
describe("lastPersistedMessage", () => {
  it("skips trailing seq:0 ephemera (warn note pinned last)", () => {
    const list = [msg("m1", 1, "human"), msg("reply", 2, "agent"), msg("warn", 0, "system")];
    expect(lastPersistedMessage(list)?.id).toBe("reply");
  });

  it("returns the plain tail when there are no ephemera", () => {
    const list = [msg("m1", 1, "human"), msg("m2", 2, "agent")];
    expect(lastPersistedMessage(list)?.id).toBe("m2");
  });

  it("treats a missing seq as ephemeral (same rule as compareMessages)", () => {
    const list = [msg("m1", 3, "human"), msg("local", undefined, "system")];
    expect(lastPersistedMessage(list)?.id).toBe("m1");
  });

  it("returns undefined for an empty list or all-ephemera list", () => {
    expect(lastPersistedMessage([])).toBeUndefined();
    expect(lastPersistedMessage([msg("warn", 0, "system")])).toBeUndefined();
  });
});

// Mirror of compareMessages' ORDERING rule (core/state.svelte.ts:13): seq:0
// (ephemera) always sorts LAST; persisted messages sort by createdAt/seq. Used
// here to build the channel list exactly as MessageList resolves it.
function sortedLikeChannelState(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const aSeq = a.seq ?? 0;
    const bSeq = b.seq ?? 0;
    if (aSeq === 0 && bSeq === 0) return a.createdAt - b.createdAt;
    if (aSeq === 0) return 1;
    if (bSeq === 0) return -1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return aSeq - bSeq;
  });
}

// REGRESSION (W3 xval finding on #366): the ephemeral warn note (seq:0, pinned
// last) was added BEFORE the dispatch captured its anchor, so slashProgress
// anchored on the NOTE's id — and the clear effect, reading the raw list tail,
// kept seeing the note after the reply landed above it. The "is summarizing…"
// indicator stayed up ~30s (the note's TTL) instead of clearing on the reply.
describe("regression: seq:0 warn note must not strand the slash-progress indicator", () => {
  // The exact /summarize-with-dirty-args timeline:
  const history = msg("m-history", 41, "human");
  const echo = msg("m-echo", 42, "human"); // the '/summarize 99999' command echo
  const warnNote = msg("warn-note", 0, "system"); // ephemeral 'Used count=1000 (max 1000).'
  const atDispatch = sortedLikeChannelState([history, echo, warnNote]);
  const reply = msg("m-reply", 43, "agent"); // the summary, lands later
  const afterReply = sortedLikeChannelState([history, echo, warnNote, reply]);

  it("PRE-FIX behavior reproduced: raw-tail anchor + raw-tail compare never clears", () => {
    // Old MessageInput anchor: the raw list tail at dispatch — the warn note,
    // because seq:0 pins it last.
    const oldAnchor = atDispatch[atDispatch.length - 1];
    expect(oldAnchor.id).toBe("warn-note");

    // Old MessageList clear: raw tail !== human && id !== anchor. The reply
    // sorts ABOVE the pinned note, so the raw tail after it lands is STILL the
    // note → same id as the anchor → never fires until the note's 30s TTL.
    const oldTailAfterReply = afterReply[afterReply.length - 1];
    expect(oldTailAfterReply.id).toBe("warn-note"); // reply did NOT become the tail
    const oldPredicateFires =
      oldTailAfterReply.fromType !== "human" && oldTailAfterReply.id !== oldAnchor.id;
    expect(oldPredicateFires).toBe(false); // ← the bug: indicator stranded ~30s
  });

  it("POST-FIX: persisted-only anchor + clear releases the indicator when the reply lands", () => {
    // New MessageInput anchor: last PERSISTED message — the command echo, not
    // the note (regardless of the note being added before the capture).
    const anchor = lastPersistedMessage(atDispatch);
    expect(anchor?.id).toBe("m-echo");

    // While generating (only the note after the echo): no premature clear —
    // the last persisted message is the human echo.
    expect(shouldClearSlashProgress(atDispatch, anchor?.id)).toBe(false);

    // The reply lands above the pinned note → cleared immediately, note still
    // present and still pinned last (it keeps its own 30s TTL independently).
    expect(shouldClearSlashProgress(afterReply, anchor?.id)).toBe(true);
    expect(afterReply[afterReply.length - 1].id).toBe("warn-note");
  });
});
