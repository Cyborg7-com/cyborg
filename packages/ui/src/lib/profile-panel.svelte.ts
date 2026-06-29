// Global rune store for the slide-in Profile side panel (matches v1
// ProfileSidePanel). A single target at a time — opening a new profile
// replaces the current one. Cleared on close.

export interface ProfileTarget {
  kind: "human" | "agent";
  id: string;
  // For a slash AI result (id starts with "provider:"), the daemon that ran it —
  // surfaced as a "Daemon" row in the sheet. Absent for other targets.
  daemonId?: string | null;
}

class ProfilePanelState {
  target: ProfileTarget | null = $state(null);

  open(kind: "human" | "agent", id: string, daemonId?: string | null): void {
    this.target = { kind, id, daemonId };
  }

  close(): void {
    this.target = null;
  }
}

export const profilePanelState = new ProfilePanelState();
