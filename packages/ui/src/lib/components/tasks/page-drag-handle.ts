// Block side-menu + drag handle for the PageEditor — the Notion/Plane "6-dots"
// grip that appears to the LEFT of the hovered block and drag-reorders blocks,
// plus a "+" affordance that inserts a new block and opens the slash menu.
//
// This is a vanilla-TipTap port of Plane's React-free ProseMirror plugins
// (`@plane/editor` core/extensions/side-menu.ts + core/plugins/drag-handle.ts):
// a single ProseMirror plugin appends a `#editor-side-menu` div next to the
// editor, hit-tests the block under the cursor on mousemove, positions the menu,
// and wires dragstart/drop/auto-scroll. Plane's block selectors depend on its
// own block classes (`editor-paragraph-block`, …); our StarterKit renders plain
// tags, so the selector set below is rewritten to match OUR rendered DOM. All
// visual styling lives in PageEditor.svelte's <style> (tokens only); this module
// stays DOM/logic-only.
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node, Schema } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const DRAG_HANDLE_WIDTH = 24;
const SCROLL_THRESHOLD = { up: 200, down: 150 };
const MAX_SCROLL_SPEED = 20;
const ACCELERATION = 0.5;

// A single vertical-ellipsis; two of these stacked with a negative offset form
// the 6-dot grip (mirrors Plane's drag-handle SVG).
const ellipsisIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
const plusIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

// Blocks our editor can grip, in OUR rendered DOM (plain StarterKit tags). Order
// matters: `nodeDOMAtCoords` returns the first match under the cursor.
const generalSelectors = [
  "li",
  "p",
  "pre",
  "blockquote",
  "h1, h2, h3, h4, h5, h6",
  "hr",
  "img",
  "table",
].join(", ");

const scrollParentCache = new WeakMap<Element, Element>();

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

function isScrollable(node: Element): boolean {
  const style = getComputedStyle(node);
  return ["overflow", "overflow-y"].some((prop) => {
    const value = style.getPropertyValue(prop);
    return value === "auto" || value === "scroll";
  });
}

function getScrollParent(node: Element): Element {
  const cached = scrollParentCache.get(node);
  if (cached) return cached;
  let parent = node.parentElement;
  while (parent) {
    if (isScrollable(parent)) {
      scrollParentCache.set(node, parent);
      return parent;
    }
    parent = parent.parentElement;
  }
  const result = document.scrollingElement ?? document.documentElement;
  scrollParentCache.set(node, result);
  return result;
}

// The block element under the given viewport coords, scoped to this editor.
function nodeDOMAtCoords(coords: { x: number; y: number }, editorDom: Element): Element | null {
  const elements = document.elementsFromPoint(coords.x, coords.y);
  for (const elem of elements) {
    if (!editorDom.contains(elem)) continue;
    if (elem.matches("table")) return elem;
    // Cells/inner content of a table aren't independently draggable.
    if (elem.closest("table")) continue;
    if (elem.matches(generalSelectors)) return elem;
  }
  return null;
}

function nodePosAtDOM(node: Element, view: EditorView): number | undefined {
  const rect = node.getBoundingClientRect();
  return view.posAtCoords({ left: rect.left + 50 + DRAG_HANDLE_WIDTH, top: rect.top + 1 })?.inside;
}

function nodePosAtDOMForBlockQuotes(node: Element, view: EditorView): number | undefined {
  const rect = node.getBoundingClientRect();
  return view.posAtCoords({ left: rect.left + 1, top: rect.top + 1 })?.inside;
}

// Flatten nested list items so a dropped list item reflows cleanly.
function flattenListStructure(fragment: Fragment, schema: Schema): Fragment {
  const result: Node[] = [];
  fragment.forEach((node) => {
    if (node.type === schema.nodes.listItem || node.type === schema.nodes.taskItem) {
      result.push(node);
      const first = node.content.firstChild;
      if (
        first &&
        (first.type === schema.nodes.bulletList || first.type === schema.nodes.orderedList)
      ) {
        flattenListStructure(first.content, schema).forEach((sub) => result.push(sub));
      }
    }
  });
  return Fragment.from(result);
}

function handleNodeSelection(
  event: MouseEvent | DragEvent,
  view: EditorView,
  isDragStart: boolean,
): { listType: string } | undefined {
  let listType = "";
  view.focus();

  const node = nodeDOMAtCoords(
    { x: event.clientX + 50 + DRAG_HANDLE_WIDTH, y: event.clientY },
    view.dom,
  );
  if (!(node instanceof Element)) return;

  let draggedNodePos = nodePosAtDOM(node, view);
  if (draggedNodePos == null || draggedNodePos < 0) return;

  if (node.matches("table")) {
    draggedNodePos = draggedNodePos - 2;
  } else if (node.matches("blockquote")) {
    const bq = nodePosAtDOMForBlockQuotes(node, view);
    if (bq == null) return;
    draggedNodePos = bq;
  } else {
    const $pos = view.state.doc.resolve(draggedNodePos);
    const parentName = $pos.parent.type.name;
    if ((parentName === "listItem" || parentName === "taskItem") && $pos.depth > 1) {
      draggedNodePos = $pos.before($pos.depth);
    }
  }

  const docSize = view.state.doc.content.size;
  draggedNodePos = Math.max(0, Math.min(draggedNodePos, docSize));

  const nodeSelection = NodeSelection.create(view.state.doc, draggedNodePos);
  view.dispatch(view.state.tr.setSelection(nodeSelection));

  if (isDragStart) {
    if (event instanceof DragEvent && !event.dataTransfer) return;

    const selectedName = nodeSelection.node.type.name;
    if (selectedName === "listItem" || selectedName === "taskItem") {
      listType = node.closest("ol, ul")?.tagName ?? "";
    }

    const slice = view.state.selection.content();
    const { dom, text } = view.serializeForClipboard(slice);

    if (event instanceof DragEvent && event.dataTransfer) {
      event.dataTransfer.clearData();
      event.dataTransfer.setData("text/html", dom.innerHTML);
      event.dataTransfer.setData("text/plain", text);
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setDragImage(node, 0, 0);
    }

    view.dragging = { slice, move: event instanceof DragEvent ? event.ctrlKey : false };
  }

  return { listType };
}

// Insert an empty paragraph after the hovered block and open the slash menu by
// typing "/" into it — the "+" affordance's behaviour (mirrors Plane's handle).
function insertBlockBelow(editor: Editor, hoveredPos: number | null): void {
  if (hoveredPos == null) return;
  const { state } = editor;
  const $pos = state.doc.resolve(Math.min(hoveredPos, state.doc.content.size));
  // Position after the top-level block that contains the hovered node.
  const after = $pos.depth > 0 ? $pos.after(1) : state.doc.content.size;
  editor
    .chain()
    .focus()
    .insertContentAt(after, { type: "paragraph" })
    .setTextSelection(after + 1)
    .insertContent("/")
    .run();
}

export function createPageDragHandle(): Extension {
  return Extension.create({
    name: "pageDragHandle",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const sideMenu = document.createElement("div");
      sideMenu.id = "editor-side-menu";
      sideMenu.classList.add("side-menu-hidden");

      let dragHandle: HTMLButtonElement | null = null;
      let insertHandle: HTMLButtonElement | null = null;
      let hoveredPos: number | null = null;

      // ── drag state ──
      let listType = "";
      let isDragging = false;
      let lastClientY = 0;
      let scrollFrame: number | null = null;
      let draggedOutside: "top" | "bottom" | false = false;
      let mouseInsideWhileDragging = false;
      let scrollSpeed = 0;

      const showSideMenu = (): void => sideMenu.classList.remove("side-menu-hidden");
      const hideSideMenu = (): void => sideMenu.classList.add("side-menu-hidden");

      function autoScroll(): void {
        if (!isDragging || !dragHandle) {
          scrollSpeed = 0;
          return;
        }
        const parent = getScrollParent(dragHandle);
        const regionUp = SCROLL_THRESHOLD.up;
        const regionDown = window.innerHeight - SCROLL_THRESHOLD.down;
        let target = 0;
        if (draggedOutside === "top") target = -MAX_SCROLL_SPEED * 5;
        else if (draggedOutside === "bottom") target = MAX_SCROLL_SPEED * 5;
        else if (lastClientY < regionUp)
          target = -MAX_SCROLL_SPEED * easeOutQuad((regionUp - lastClientY) / SCROLL_THRESHOLD.up);
        else if (lastClientY > regionDown)
          target =
            MAX_SCROLL_SPEED * easeOutQuad((lastClientY - regionDown) / SCROLL_THRESHOLD.down);
        scrollSpeed += (target - scrollSpeed) * ACCELERATION;
        if (Math.abs(scrollSpeed) > 0.1) parent.scrollBy({ top: scrollSpeed });
        scrollFrame = requestAnimationFrame(autoScroll);
      }

      function endDrag(view?: EditorView): void {
        isDragging = false;
        mouseInsideWhileDragging = false;
        if (scrollFrame) {
          cancelAnimationFrame(scrollFrame);
          scrollFrame = null;
        }
        view?.dom.classList.remove("dragging");
      }

      const buildHandles = (view: EditorView): (() => void) => {
        insertHandle = document.createElement("button");
        insertHandle.type = "button";
        insertHandle.id = "page-insert-handle";
        insertHandle.setAttribute("aria-label", "Insert block");
        insertHandle.title = "Insert block";
        insertHandle.innerHTML = plusIcon;
        insertHandle.addEventListener("click", (e) => {
          e.preventDefault();
          insertBlockBelow(editor, hoveredPos);
        });

        dragHandle = document.createElement("button");
        dragHandle.type = "button";
        dragHandle.id = "drag-handle";
        dragHandle.draggable = true;
        dragHandle.dataset.dragHandle = "";
        dragHandle.setAttribute("aria-label", "Drag to reorder");
        dragHandle.title = "Drag to reorder";
        const grip1 = document.createElement("span");
        grip1.className = "drag-grip";
        grip1.innerHTML = ellipsisIcon;
        const grip2 = document.createElement("span");
        grip2.className = "drag-grip drag-grip-2";
        grip2.innerHTML = ellipsisIcon;
        dragHandle.append(grip1, grip2);

        dragHandle.addEventListener("dragstart", (e) => {
          const r = handleNodeSelection(e, view, true);
          if (r?.listType) listType = r.listType;
          isDragging = true;
          lastClientY = e.clientY;
          autoScroll();
        });
        dragHandle.addEventListener("dragend", (e) => {
          e.preventDefault();
          endDrag(view);
        });
        dragHandle.addEventListener("click", (e) => handleNodeSelection(e, view, false));

        const onDragOver = (e: DragEvent): void => {
          e.preventDefault();
          if (isDragging) lastClientY = e.clientY;
        };
        const onMouseMove = (): void => {
          if (mouseInsideWhileDragging) endDrag(view);
        };
        const onDragLeave = (e: DragEvent): void => {
          if (
            e.clientY <= 0 ||
            e.clientX <= 0 ||
            e.clientX >= window.innerWidth ||
            e.clientY >= window.innerHeight
          ) {
            mouseInsideWhileDragging = true;
            draggedOutside = lastClientY < window.innerHeight / 2 ? "top" : "bottom";
          }
        };
        const onDragEnter = (): void => {
          draggedOutside = false;
        };

        window.addEventListener("dragleave", onDragLeave);
        window.addEventListener("dragenter", onDragEnter);
        document.addEventListener("dragover", onDragOver);
        document.addEventListener("mousemove", onMouseMove);

        sideMenu.append(insertHandle, dragHandle);

        return () => {
          window.removeEventListener("dragleave", onDragLeave);
          window.removeEventListener("dragenter", onDragEnter);
          document.removeEventListener("dragover", onDragOver);
          document.removeEventListener("mousemove", onMouseMove);
        };
      };

      let teardown: (() => void) | null = null;

      return [
        new Plugin({
          key: new PluginKey("pageSideMenu"),
          view: (view) => {
            hideSideMenu();
            view.dom.parentElement?.appendChild(sideMenu);
            if (!sideMenu.querySelector("#drag-handle")) teardown = buildHandles(view);
            return {
              destroy: () => {
                teardown?.();
                teardown = null;
                if (scrollFrame) cancelAnimationFrame(scrollFrame);
                sideMenu.remove();
              },
            };
          },
          props: {
            handleDOMEvents: {
              mousemove: (view, event) => {
                if (!view.editable) return false;
                const node = nodeDOMAtCoords(
                  { x: event.clientX + 50 + DRAG_HANDLE_WIDTH, y: event.clientY },
                  view.dom,
                );
                if (!(node instanceof Element) || node.matches("ul, ol")) {
                  hideSideMenu();
                  return false;
                }
                const cs = getComputedStyle(node);
                const lineHeight = parseInt(cs.lineHeight, 10) || 0;
                const paddingTop = parseInt(cs.paddingTop, 10) || 0;
                const rect = node.getBoundingClientRect();
                const parent = view.dom.parentElement;
                if (!parent) return false;
                const parentRect = parent.getBoundingClientRect();
                let top = rect.top - parentRect.top + parent.scrollTop;
                let left = rect.left - parentRect.left + parent.scrollLeft;
                top += (lineHeight - 20) / 2 + paddingTop;
                if (node.matches("ul:not([data-type=taskList]) li, ol li")) left -= 18;
                if (node.matches("table")) {
                  top += 8;
                  left -= 8;
                }
                sideMenu.style.left = `${left - DRAG_HANDLE_WIDTH * 2}px`;
                sideMenu.style.top = `${top}px`;
                hoveredPos =
                  view.posAtCoords({
                    left: rect.left + 50 + DRAG_HANDLE_WIDTH,
                    top: rect.top + 1,
                  })?.inside ?? null;
                showSideMenu();
                dragHandle?.classList.remove("drag-handle-hidden");
                return false;
              },
              mousewheel: () => {
                hideSideMenu();
                return false;
              },
              dragenter: (view) => {
                view.dom.classList.add("dragging");
                dragHandle?.classList.add("drag-handle-hidden");
                return false;
              },
              drop: (view, event) => {
                view.dom.classList.remove("dragging");
                dragHandle?.classList.add("drag-handle-hidden");
                let droppedNode: Node | null = null;
                const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
                if (!dropPos) return false;
                if (view.state.selection instanceof NodeSelection)
                  droppedNode = view.state.selection.node;
                if (!droppedNode) return false;

                const $pos = view.state.doc.resolve(dropPos.pos);
                let insideList = false;
                let dropDepth = 0;
                for (let i = $pos.depth; i > 0; i--) {
                  if ($pos.node(i).type.name === "listItem") {
                    insideList = true;
                    dropDepth = i;
                    break;
                  }
                }
                if (droppedNode.type.name === "listItem") {
                  let slice = view.state.selection.content();
                  let frag = slice.content;
                  if (!insideList || dropDepth !== $pos.depth)
                    frag = flattenListStructure(frag, view.state.schema);
                  if (!insideList) {
                    const listNodeType =
                      listType === "OL"
                        ? view.state.schema.nodes.orderedList
                        : view.state.schema.nodes.bulletList;
                    frag = Fragment.from(listNodeType.create(null, frag));
                  }
                  slice = new Slice(frag, slice.openStart, slice.openEnd);
                  view.dragging = { slice, move: event.ctrlKey };
                }
                return false;
              },
              dragend: (view) => {
                view.dom.classList.remove("dragging");
                endDrag(view);
                return false;
              },
            },
          },
        }),
      ];
    },
  });
}
