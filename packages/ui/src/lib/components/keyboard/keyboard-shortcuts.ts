// Central registry of keyboard shortcuts surfaced in the help modal (Cmd/Ctrl-/).
// Each entry carries a "logical" combo using the "Mod" placeholder for the
// platform command/control key — formatShortcut() renders it as ⌘ on macOS and
// Ctrl elsewhere. This is documentation-only: the actual handlers live in the
// components that own each shortcut (QuickSwitcher, ChannelSidebar, MessageInput,
// MessageSearch). Keeping the list here lets the modal stay in sync without
// duplicating glyph logic.

export interface ShortcutDef {
  // Logical combo, e.g. "Mod+K", "Alt+Up", "Shift+Alt+Up".
  combo: string;
  description: string;
}

export interface ShortcutGroup {
  category: string;
  shortcuts: ShortcutDef[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: "Navigation",
    shortcuts: [
      { combo: "Mod+K", description: "Open quick switcher (jump to channel, person, or agent)" },
      { combo: "Alt+Up", description: "Go to previous channel" },
      { combo: "Alt+Down", description: "Go to next channel" },
      { combo: "Shift+Alt+Up", description: "Go to previous unread channel" },
      { combo: "Shift+Alt+Down", description: "Go to next unread channel" },
      { combo: "Mod+Shift+\\", description: "Toggle sidebar" },
    ],
  },
  {
    category: "Search",
    shortcuts: [{ combo: "Mod+F", description: "Search messages" }],
  },
  {
    category: "Messaging",
    shortcuts: [
      { combo: "Mod+Enter", description: "Send message" },
      { combo: "Up", description: "Edit your last message (when the composer is empty)" },
    ],
  },
  {
    category: "Help",
    shortcuts: [{ combo: "Mod+/", description: "Show keyboard shortcuts" }],
  },
];
