// (F) Optimistic "a slash command is generating its reply" indicator.
//
// The slash RESPONSE arrives asynchronously as a normal channel message well
// after the dispatch ack, so the composer can't tell when it's done from the RPC
// alone. The composer calls start() on a successful dispatch; the indicator
// auto-clears on a timeout just past the server's 30s slash budget, and
// MessageList also clears it as soon as the response (a non-human message) lands.
//
// INTEGRATION NOTE (W2): when the server-side slash-progress event lands in
// cyborg-messages.ts, route its start/finish through start()/clear() here for a
// precise lifecycle (and a server-authored label) instead of this optimistic
// timeout — the consumer (MessageList) needs no change.

const GERUND: Record<string, string> = {
  summarize: "summarizing",
  "action-items": "gathering action items",
  standup: "compiling the standup",
  translate: "translating",
};

// "Pi is summarizing" — the verb follows the command; the actor is the configured
// slash provider label (or a neutral fallback when the model is auto-resolved).
// No trailing ellipsis: the TypingIndicator that renders it appends one.
export function slashProgressLabel(trigger: string, actor: string | null): string {
  const verb = GERUND[trigger] ?? "working";
  return `${actor ?? "Cyborg7"} is ${verb}`;
}

class SlashProgressState {
  private entries = $state<Record<string, { label: string; lastMessageId?: string }>>({});
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  get(channelId: string | null | undefined): { label: string; lastMessageId?: string } | undefined {
    return channelId ? this.entries[channelId] : undefined;
  }

  // lastMessageId = the id of the channel's last message AT DISPATCH; MessageList
  // clears once a newer non-human message (a different last id) lands. Immune to
  // client/server clock skew (no timestamp compare).
  start(channelId: string, label: string, lastMessageId?: string): void {
    this.entries = { ...this.entries, [channelId]: { label, lastMessageId } };
    const prev = this.timers.get(channelId);
    if (prev) clearTimeout(prev);
    // Safety auto-clear: just past the server's 30s slash timeout so a dropped
    // response never leaves the indicator stuck.
    this.timers.set(
      channelId,
      setTimeout(() => this.clear(channelId), 35_000),
    );
  }

  clear(channelId: string): void {
    if (!this.entries[channelId]) return;
    const next = { ...this.entries };
    delete next[channelId];
    this.entries = next;
    const t = this.timers.get(channelId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(channelId);
    }
  }
}

export const slashProgress = new SlashProgressState();
