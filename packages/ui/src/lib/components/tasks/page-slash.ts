// Slash-command extension for the PageEditor — typing "/" opens a command menu
// (Text, Headings, lists, quote, code, image, table, divider) mirroring Plane's
// editor slash menu. Built on @tiptap/suggestion: this file owns the command
// catalog + the ProseMirror plugin; the visible menu lives in PageEditor.svelte
// (driven through the `controller` callbacks) so it can use theme tokens.
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";

// Icon keys map to inline SVGs rendered by the Svelte menu (keeps this module
// DOM-free). Each command runs after the typed "/query" range is removed.
export interface SlashItem {
  key: string;
  title: string;
  description: string;
  iconKey: string;
  searchTerms: string[];
  command: (props: { editor: Editor; range: Range }) => void;
}

// Live menu state handed to the controller on open/update so the Svelte side can
// render + position the popup and run the picked item.
export interface SlashRenderState {
  items: SlashItem[];
  select: (item: SlashItem) => void;
  rect: (() => DOMRect | null) | null;
}

// The PageEditor implements this to render/position the menu and route keys.
export interface SlashController {
  onStart: (s: SlashRenderState) => void;
  onUpdate: (s: SlashRenderState) => void;
  onKeyDown: (e: KeyboardEvent) => boolean;
  onExit: () => void;
}

// The full command catalog, in Plane's order. `onPickImage` is deferred to the
// host (an async S3 upload happens outside the editor transaction).
function buildItems(onPickImage: () => void): SlashItem[] {
  return [
    {
      key: "text",
      title: "Text",
      description: "Plain paragraph",
      iconKey: "text",
      searchTerms: ["paragraph", "plain"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setParagraph().run(),
    },
    {
      key: "h1",
      title: "Heading 1",
      description: "Large section heading",
      iconKey: "h1",
      searchTerms: ["title", "big", "h1"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
    },
    {
      key: "h2",
      title: "Heading 2",
      description: "Medium section heading",
      iconKey: "h2",
      searchTerms: ["subtitle", "h2"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
    },
    {
      key: "h3",
      title: "Heading 3",
      description: "Small section heading",
      iconKey: "h3",
      searchTerms: ["h3"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
    },
    {
      key: "bullet",
      title: "Bulleted list",
      description: "Simple bulleted list",
      iconKey: "bullet",
      searchTerms: ["unordered", "ul", "list"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      key: "ordered",
      title: "Numbered list",
      description: "Numbered list",
      iconKey: "ordered",
      searchTerms: ["ordered", "ol", "list"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      key: "quote",
      title: "Quote",
      description: "Capture a quote",
      iconKey: "quote",
      searchTerms: ["blockquote", "citation"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      key: "code",
      title: "Code",
      description: "Code block",
      iconKey: "code",
      searchTerms: ["codeblock", "snippet", "pre"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      key: "image",
      title: "Image",
      description: "Upload an image",
      iconKey: "image",
      searchTerms: ["photo", "picture", "media", "upload"],
      // Remove the "/query" first, then hand off to the host's file picker; the
      // upload + insert happens once a file is chosen.
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        onPickImage();
      },
    },
    {
      key: "table",
      title: "Table",
      description: "Insert a 3×3 table",
      iconKey: "table",
      searchTerms: ["grid", "rows", "columns"],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      key: "divider",
      title: "Divider",
      description: "Horizontal rule",
      iconKey: "divider",
      searchTerms: ["hr", "separator", "line"],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
  ];
}

function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.description.toLowerCase().includes(q) ||
      it.searchTerms.some((t) => t.includes(q)),
  );
}

export function createPageSlash(opts: {
  controller: SlashController;
  onPickImage: () => void;
}): Extension {
  const allItems = buildItems(opts.onPickImage);
  return Extension.create({
    name: "pageSlashCommands",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          // Only open the menu when "/" begins a block or directly follows
          // whitespace — never mid-word or inside a URL (e.g. "http://", "a/b").
          // Mirrors Plane's slash guard, but resolves the real document char
          // before the trigger so it also holds across mark/text-node splits
          // (TipTap's built-in prefix check only sees the trailing text node).
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parentOffset === 0) return true;
            // textBetween reads the char before "/" across mark boundaries; leaf
            // nodes (image, hard break) count as whitespace so "/" still opens.
            const charBefore = state.doc.textBetween(range.from - 1, range.from, undefined, " ");
            return /\s/.test(charBefore);
          },
          items: ({ query }) => filterItems(allItems, query),
          command: ({ editor, range, props }) => props.command({ editor, range }),
          render: () => ({
            onStart: (props) =>
              opts.controller.onStart({
                items: props.items,
                select: props.command,
                rect: props.clientRect ?? null,
              }),
            onUpdate: (props) =>
              opts.controller.onUpdate({
                items: props.items,
                select: props.command,
                rect: props.clientRect ?? null,
              }),
            onKeyDown: (props) => opts.controller.onKeyDown(props.event),
            onExit: () => opts.controller.onExit(),
          }),
        }),
      ];
    },
  });
}
