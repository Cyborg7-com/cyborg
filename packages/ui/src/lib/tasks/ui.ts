// Single source of truth for the Plane-faithful Tasks look. Pure strings only,
// every class resolves through an app.css semantic token so dark + light both
// work. Surfaces (board, list, toolbar, dialogs, peek) compose these — do NOT
// re-hardcode the look in a component; import the constant and add only the
// STATEFUL classes (dragging / selected / peeked / active) at the call site via
// cn()/clsx.
//
// Token mapping (Plane role -> our utility, verified against app.css dark
// 203-414 + light 416-615):
//   bg-canvas (board) -> bg-tasks-board  (--tasks-board-bg, Plane dark canvas)
//   bg-surface-2 col  -> bg-tasks-column (--tasks-column-bg, Plane dark surface-2)
//   column border     -> border-tasks-column-border (--tasks-column-border, Plane border-subtle)
//   bg-surface-1     -> bg-surface-alt   (--bg-surface)
//   bg-layer-1/2tint -> bg-deeper        (--bg-deeper)
//   bg-layer-2 card  -> bg-tasks-card    (--tasks-card-bg, Plane dark layer-2)
//   card border      -> border-tasks-card(--tasks-card-border, Plane border-subtle)
//   hover 5%         -> hover:bg-hover-gray (--hover-gray)
//   active/selected  -> bg-dropdown-selected (--dropdown-selected)
//   border default   -> border-edge      (--border)
//   border hover     -> border-edge-light(--border-light)
//   focus/peeked     -> border-accent / ring-accent (--c7-accent)
//   txt primary/sec/ter -> text-content / -dim / -muted
//   link / accent text  -> text-accent   (--c7-accent)
//   on-accent text   -> text-[color:var(--brand-contrast)]
//   card elevation   -> shadow-[var(--shadow-task-card)] / -hover (new token pair)
//
// Bracket-literals are intentional and limited to: font-size geometry
// (text-[13px] — Plane's text-13 has no entry in our type scale; the color
// always comes from a text-* token), and var(--…) references inside
// shadow-[…] / z-[…] / ring-[…] / text-[color:var(--…)]. There are ZERO raw
// color literals here.

// ── KANBAN CARD ──────────────────────────────────────────────────────────────
// Plane block.tsx: rounded-lg border bg-layer-2 p-3 text-13 shadow-raised-100,
// hover border-strong + shadow-raised-200; space-y-2 inside.
// FAITHFUL Plane block.tsx:273-285 reproduction. Base card = the visible
// ControlLink <a>: rounded-lg, border border-subtle, bg-layer-2, p-3 (12px),
// text-13, shadow-raised-100; hover -> border-strong + shadow-raised-200; the
// outer wrapper carries group/kanban-block + mb-2 (8px between cards). We keep
// Plane's exact geometry (rounded-lg, p-3, the outline-[0.5px] transparent
// outline that lifts on drag) and route only COLOR through tokens. text-[13px]
// = Plane text-13 (no scale entry).
export const cardBase =
  "group/kanban-block relative mb-2 block w-full rounded-lg border border-tasks-card-border " +
  "bg-tasks-card-bg p-3 text-[13px] text-content shadow-[var(--shadow-task-card)] " +
  "outline-[0.5px] outline-transparent transition-all duration-[var(--duration-fast)] " +
  "hover:border-edge-light hover:shadow-[var(--shadow-task-card-hover)]";
export const cardPeeked = "border-accent hover:border-accent"; // peeked: Plane border-accent-strong
export const cardDragging = "z-[var(--z-elevated)] bg-surface-alt opacity-95";
// Plane block.tsx:287 RenderIfVisible classNames="space-y-2" — 8px vertical gap
// between the 3 stacked rows (id-row / title / properties strip).
export const cardStack = "space-y-2";
// Plane block.tsx:103-111 IssueIdentifier size=xs variant=tertiary — the muted
// PROJ-123 key text. The kanban card sets a base text-13 (block.tsx:278 ControlLink
// `text-13`), which the key inherits => 13px.
export const cardIdRow = "flex items-center gap-1 text-[13px] text-content-muted";
// Plane block.tsx:128 title: line-clamp-1, text-body-sm-medium, text-primary.
export const cardTitle = "line-clamp-1 text-[14px] font-medium text-content";
// Plane block.tsx:134 IssueProperties container = flex flex-wrap items-center
// gap-2 (8px) pt-1.5 (6px) whitespace-nowrap text-tertiary.
export const cardPropsRow =
  "flex flex-wrap items-center gap-2 whitespace-nowrap pt-1.5 text-content-muted";
// Hover-reveal target for the per-card quick-actions trigger (the "…" menu).
// Plane pins this absolutely in ROW 1's `relative` box (-top-1 right-0) and reveals
// it via the named kanban-block group, so the KEY never shares the row's flow with
// it and the trigger overlays the top-right corner whether or not the key shows.
export const cardQuickAction =
  "absolute -top-1 right-0 opacity-0 transition-opacity " +
  "group-hover/kanban-block:opacity-100 focus-within:opacity-100";

// ── BOARD COLUMNS ────────────────────────────────────────────────────────────
// The board is ONE canvas color (bg-tasks-board — the BOARD-SCOPED Plane canvas
// = bg-canvas, NOT the app-wide bg-surface) with NO border around the board and
// NO vertical separators — the "cuadricula"/grid look is gone. Over that canvas
// each column is a SUBTLE distinct surface (bg-tasks-column = Plane's
// bg-surface-2, one neutral step lighter than the canvas) wrapped in a hairline
// border (border-tasks-column-border = Plane's border-subtle): a visible-but-
// quiet box, not a flat fill and not a hard grid. Inside it the cards layer one
// step further (bg-tasks-card = bg-layer-2 + their own border-subtle hairline +
// raised shadow), so the surface ladder reads canvas → column → card.
//
// TWO ELEMENTS, like Plane (base-kanban-root.tsx:264 OUTER scroller + the inner
// columns wrapper at :267): the GROWTH and the SCROLL must live on DIFFERENT
// elements, or the column track never scrolls on a narrow viewport. `boardScrollOuter`
// is the viewport-bounded SCROLLER — `w-full` (NOT w-max) so it stays the viewport
// width, with `overflow-x-auto` so it scrolls when its child is wider; it owns the
// board canvas color. `boardScrollInner` is the columns ROW — `w-max min-w-full` so
// it GROWS past the viewport (which is what makes the outer scroll) while still
// filling the canvas when the columns don't fill the width; it hugs the columns to
// the left and carries the inter-column gap + padding. gap-4 (16px) and the 350px
// column width match Plane.
export const boardScrollOuter = "h-full w-full overflow-x-auto overflow-y-hidden bg-tasks-board-bg";
export const boardScrollInner = "flex h-full w-max min-w-full gap-4 p-2";
// A column = a subtle bg-tasks-column box with a border-tasks-column-border
// hairline and rounded-lg corners, so it reads as a distinct surface over the
// canvas (not flat). The card stack scrolls inside it. Fixed 350px wide.
export const column =
  "flex w-[350px] shrink-0 flex-col rounded-lg border border-tasks-column-border " +
  "bg-tasks-column-bg p-1";
// Plane kanban header (headers/group-by-card.tsx:114-140): a plain inline row —
// `flex gap-1 py-1.5 w-full flex-row items-center` with NO border-bottom divider
// and NO thick padding band. Just a light row over the column surface holding the
// fixed icon box + title + count + add. font-medium text-primary on the title.
export const columnHeader =
  "flex items-center gap-1 px-1 py-1.5 text-[14px] font-medium text-content";
// Plane count (group-by-card.tsx:135-138): `flex-shrink-0 text-13 font-medium
// text-tertiary pl-2` — a plain tertiary (muted) number, small gap after the name.
export const columnCount = "shrink-0 pl-2 text-[13px] font-medium text-content-muted";
// Plane's fixed icon box (group-by-card.tsx:119): `flex size-5 flex-shrink-0
// items-center justify-center overflow-hidden rounded-xs` — the state/group icon
// sits in a fixed 20px square so titles line up regardless of the icon's size.
export const columnIcon = "grid size-5 shrink-0 place-items-center overflow-hidden rounded-[2px]";

// ── COLUMN COLLAPSE ──────────────────────────────────────────────────────────
// Plane collapses a board column to a narrow vertical rail (the header rotated
// 90°, cards hidden). `columnCollapsed` is the collapsed column SHELL — a slim
// 44px-wide track that keeps the SAME subtle box as the expanded column
// (bg-tasks-column + border-tasks-column-border hairline + rounded-lg) so the
// collapsed rail reads as the same surface, just narrowed; it replaces `column`'s
// width/padding. `columnCollapsedHeader` stacks the (vertical) title + count; the
// surface adds `[writing-mode:vertical-rl]` at the call site for the rotated label.
export const columnCollapsed =
  "flex w-[44px] shrink-0 flex-col items-center gap-2 rounded-lg " +
  "border border-tasks-column-border bg-tasks-column-bg p-1";
export const columnCollapsedHeader =
  "flex flex-col items-center gap-2 pt-1 text-[13px] font-medium text-content";
// The collapse / expand chevron button that sits in the column header (and in
// the collapsed rail). Square, quiet, hover-tinted — matches Plane's icon button.
export const columnCollapseBtn =
  "grid size-5 shrink-0 place-items-center rounded-[4px] text-content-dim " +
  "transition-colors hover:bg-hover-gray hover:text-content";
// Column footer quick-add affordance — Plane kanban quick-add/button/kanban.tsx:
// `text-13 font-medium` with NO explicit text-color class, so it inherits the
// DEFAULT text color (text-content), NOT an accent/muted tint. Plane label weight
// is medium. Pinned at the column foot (sticky bottom in Plane). This is the
// CLOSED state of the board quick-add (the "+ New work item" row); clicking it
// swaps in the inline composer card below.
export const columnAdd =
  "flex w-full items-center gap-1.5 rounded-[4px] px-1 py-1.5 text-[13px] " +
  "font-medium text-content hover:bg-hover-gray";
// The OPEN state of the board quick-add — Plane's KanbanQuickAddIssueForm
// (quick-add/form/kanban.tsx): `m-1 overflow-hidden rounded-sm bg-layer-2
// shadow-raised-200` — a layer-2 card with the raised card shadow, holding the
// title input over a one-step-deeper footer hint band. We keep Plane's geometry
// (rounded card, clipped corners, raised shadow) and route only COLOR through
// tokens, so dark + light both resolve. `mb-2` matches the card stack's
// inter-card gap so the composer sits flush in the column.
//   bg-layer-2     -> bg-tasks-card-bg (the card/layer-2 surface token)
//   border         -> border-tasks-card-border (the card hairline)
//   shadow-raised  -> shadow-[var(--shadow-task-card)] (the raised card shadow)
export const boardQuickAddCard =
  "mb-2 overflow-hidden rounded-lg border border-tasks-card-border bg-tasks-card-bg " +
  "shadow-[var(--shadow-task-card)]";
// Plane form/kanban.tsx title input — a borderless field (`w-full bg-transparent
// px-2 py-1.5 pl-0 text-13 font-medium text-secondary outline-none`). Padding is
// owned by the wrapping `p-3` box (mirroring Plane's `p-3` form), so this carries
// no inset; text-content for the typed value, muted placeholder.
export const boardQuickAddInput =
  "w-full bg-transparent text-[13px] font-medium text-content " +
  "placeholder:text-content-muted focus:outline-none";
// Plane form/kanban.tsx footer hint band — `bg-layer-3 px-3 py-2 text-11
// text-tertiary italic` — a one-step-deeper strip carrying the "Press 'Enter' to
// add another work item" helper.
//   bg-layer-3 -> bg-deeper ; text-tertiary -> text-content-muted.
export const boardQuickAddHint = "bg-deeper px-3 py-2 text-[11px] italic text-content-muted";

// ── LIST (Plane list/block.tsx + block-root.tsx — element-for-element fork) ───
// Plane's list block is a flex DIV row, NOT a table row. The structure is:
//   block-root.tsx:136  RenderIfVisible wrapper — carries the per-row BOTTOM
//                       hairline (`border-b border-b-subtle`), suppressed on the
//                       last child / when expanded. `listRowWrap` is that wrapper;
//                       the call site drops `listRowBorder` on the last row.
//   block.tsx:187       <Row> — `group/list-block relative flex min-h-11 ... py-3
//                       text-13 hover:bg-...`. Peeked → border-accent, selected →
//                       bg-accent/5, added at the call site via cn(). OUR fork
//                       keeps the 44px target through `min-h-11` (not a fixed
//                       h-11) so a wrapped row can grow, exactly like Plane.
// Plane list group header (list/headers/group-by-card.tsx:97): a PLAIN row —
// `flex w-full flex-shrink-0 items-center gap-2 py-1.5` with NO background band
// and NO border. The icon + title + count + add sit inline over the list surface;
// Plane toggles collapse via the title row itself, so there is NO leading chevron
// glyph. font-medium text-primary on the title.
export const listGroupHeader =
  "flex w-full items-center gap-2 px-3 py-2 text-[15px] font-semibold text-content";
// block-root.tsx:136 — the virtualization wrapper that owns the row's bottom
// hairline. Plane suppresses the border on the last child (`listRowBorder` is
// added per-row except the last) so the group's final row sits flush.
export const listRowWrap = "relative";
export const listRowBorder = "border-b border-edge";
// block.tsx:187 — THE ROW. `group/list-block` is the hover-reveal hook (the
// select checkbox + quick-actions opacity key off it). Plane: min-h-11, flex-col
// gap-3 → flex-row at the responsive breakpoint; we settle on the always-
// horizontal form (flex-row items-center) since our property strip stays inline.
export const listRow =
  "group/list-block relative flex min-h-11 items-center gap-2 px-3 py-3 " +
  "text-[13px] text-content transition-colors hover:bg-hover-gray";
// block.tsx:188-189 — selected → accent tint, peeked → accent border. We map the
// peek to border-accent (Plane's border-accent-strong) and selection to our
// dropdown-selected tint (the same surface the board uses).
export const listRowSelected = "bg-dropdown-selected";
export const listRowPeeked = "border border-accent";
// block.tsx:210 — the TOP line wrapping the left grow cluster + the right cluster
// (`flex w-full gap-2 truncate`). Holds both clusters on the single row line.
export const listRowTop = "flex w-full gap-2 truncate";
// block.tsx:211 — the LEFT grow cluster (`flex flex-grow items-center gap-0.5
// truncate`). Everything left of the property strip lives here.
export const listRowLeft = "flex min-w-0 flex-grow items-center gap-0.5 truncate";
// block.tsx:212 — the leading indent + icon group (`flex items-center gap-1`)
// holding the hover select checkbox + the identifier.
export const listRowLead = "relative flex items-center gap-1";
// block.tsx:214-224 — the hover-revealed multi-select checkbox slot, pinned
// `absolute left-1 grid w-3.5 place-items-center`, revealed via group/list-block.
export const listRowSelect =
  "absolute left-1 grid w-3.5 shrink-0 place-items-center opacity-0 transition-opacity " +
  "group-hover/list-block:opacity-100";
// block.tsx:242 — the work-item KEY. Plane computes a per-project min-width
// (calculateIdentifierWidth) so titles line up; we apply a fixed min-width that
// fits a typical "ABC-1234" key for the same column alignment.
export const listRowId = "min-w-[3.5rem] shrink-0 text-[13px] text-content-muted";
// block.tsx:285 — the TITLE: `cursor-pointer truncate text-body-xs-medium
// text-primary` (single-line truncate, inherits the row's 13px).
export const listRowTitle = "min-w-0 flex-1 truncate text-content";
// block.tsx:311 — the RIGHT cluster (`flex flex-shrink-0 items-center gap-2`),
// never shrinks; holds the property strip + the desktop quick-actions.
export const listRowProps = "flex shrink-0 items-center gap-2 text-content-muted";
// block.tsx:315 — the shared IssueProperties wrapper: `relative flex flex-wrap
// lg:flex-shrink-0 lg:flex-grow items-center gap-2 whitespace-nowrap`.
export const listRowPropsStrip =
  "relative flex flex-wrap items-center gap-2 whitespace-nowrap lg:flex-shrink-0 lg:flex-grow";
export const loadMore =
  "flex h-11 w-full items-center justify-center border-t border-edge " +
  "px-3 text-[13px] text-accent hover:bg-hover-gray";
// Plane list-group footer quick-add (quick-add/button/list.tsx, wrapped by the
// QuickAddIssueRoot's `border-b border-t border-subtle` container): a full-width
// row — Plus glyph + "New work item" — sitting under a group's rows, aligned to
// the row gutter (px-3) and tinting on hover. Per Plane it carries the SAME 44px
// row rhythm (h-11 / py-3) and top + bottom hairlines so it reads as the group's
// footer (the top hairline separates it from the last, borderless row above).
// Plane quick-add/button/list.tsx: `text-13 font-medium` with NO explicit text-
// color class -> inherits the DEFAULT text color (text-content), NOT a muted tint.
export const listGroupAdd =
  "flex h-11 w-full cursor-pointer items-center gap-2 border-b border-t border-edge px-3 " +
  "text-[13px] font-medium text-content transition-colors hover:bg-hover-gray";

// ── CONTROLS (toolbar / filters) ─────────────────────────────────────────────
export const segmentTrack = "flex items-center gap-1 rounded-md bg-deeper p-1";
export const segmentBtn =
  "grid size-7 place-items-center rounded-[4px] text-content-dim " +
  "transition-colors hover:bg-hover-gray";
// Plane's selected layout button: a translucent raised fill over the tray plus
// full-strength icon color, so the active layout reads clearly SELECTED against
// the muted (text-content-dim) inactive ones.
export const segmentBtnActive =
  "bg-tasks-segment-active text-content hover:bg-tasks-segment-active";
export const controlBtn =
  "inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-alt " +
  "px-2 py-1 text-[13px] text-content-dim transition-colors hover:bg-hover-gray " +
  "hover:text-content";
// DropdownMenuContent / Select.Content class override when a tasks menu needs
// the Plane panel shape (the primitives already portal + theme; this only tunes
// the geometry/width when a surface wants it explicitly).
export const menuPanel =
  "min-w-[220px] rounded-md border border-dropdown-border bg-dropdown-bg shadow-[var(--dropdown-shadow)]";
export const filterOption =
  "flex w-full items-center gap-2 rounded-[4px] p-1.5 text-[13px] " +
  "text-content-dim transition-colors hover:bg-hover-gray";
// Square (multi-select) checkbox. Add `rounded-full` at the call site for the
// circle (single-select / group-by) variant.
export const checkBoxBase =
  "grid size-3 shrink-0 place-items-center rounded-[3px] border border-edge-light";
export const checkBoxChecked = "border-accent bg-accent text-[color:var(--brand-contrast)]";
export const filterChip =
  "inline-flex items-center gap-1 rounded-[4px] bg-deeper px-1.5 py-0.5 " +
  "text-[13px] text-content-dim";
// "Clear all" link beside the applied-filter chips.
export const clearAll = "text-[13px] text-accent hover:underline";

// ── DISPLAY / ORDER-BY MENU ──────────────────────────────────────────────────
// The toolbar's "Display" popover groups the Ordering radio list and the
// Display-properties toggle list. `menuSectionLabel` is the small caps section
// heading ("Ordering" / "Display properties"). `menuItemRow` is one tappable
// row in either list — a full-width left-aligned row with a trailing control
// (a check for the selected ordering, a switch/checkbox for a display prop).
// `menuItemRowActive` tints the currently-selected ordering row.
export const menuSectionLabel =
  "px-1.5 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-content-muted";
export const menuItemRow =
  "flex w-full items-center justify-between gap-2 rounded-[4px] px-1.5 py-1.5 " +
  "text-[13px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content";
export const menuItemRowActive = "bg-dropdown-selected text-content";
// Trailing check glyph wrapper on the selected ordering row.
export const menuItemCheck = "text-accent";
// The asc/desc direction toggle button beside the Ordering list.
export const orderDirToggle =
  "inline-flex items-center gap-1 rounded-[4px] px-1.5 py-1 text-[13px] " +
  "text-content-dim transition-colors hover:bg-hover-gray hover:text-content";

// ── DIALOG / PEEK FIELDS ─────────────────────────────────────────────────────
export const modalPanel = "w-full max-w-2xl rounded-lg border border-edge bg-surface";
export const modalHeader =
  "flex items-center justify-between border-b border-edge px-4 py-3 text-content";
export const modalBody = "space-y-4 p-4";
export const modalFooter = "flex items-center justify-end gap-2 border-t border-edge px-4 py-3";
export const fieldGrid = "grid grid-cols-1 gap-3 sm:grid-cols-2"; // properties grid
export const fieldLabel = "text-[13px] font-medium text-content-dim";
export const titleInput =
  "w-full bg-transparent text-[15px] font-medium text-content " +
  "placeholder:text-content-muted focus:outline-none";
export const btnPrimary =
  "inline-flex h-8 items-center rounded-md bg-accent px-4 text-[13px] " +
  "font-medium text-[color:var(--brand-contrast)] transition-colors " +
  "hover:bg-accent-hover disabled:opacity-50";
export const btnSecondary =
  "inline-flex h-8 items-center rounded-md border border-edge bg-surface-alt " +
  "px-4 text-[13px] text-content transition-colors hover:bg-hover-gray";

// ── PEEK CONTAINER (side / modal / full) ─────────────────────────────────────
export const peekSide =
  "absolute inset-y-0 right-0 z-[var(--z-modal)] w-full border-l border-edge " +
  "bg-surface shadow-[var(--modal-shadow)] md:w-1/2";
export const peekModal =
  "fixed left-1/2 top-1/2 z-[var(--z-modal)] size-5/6 -translate-x-1/2 " +
  "-translate-y-1/2 rounded-lg border border-edge bg-surface shadow-[var(--modal-shadow)]";
// Fullscreen peek: covers the whole viewport, no border/radius (Plane's
// "full screen" peek mode). Sits above the modal layer like the other variants.
export const peekFull = "fixed inset-0 z-[var(--z-modal)] flex flex-col bg-surface";
// The side/modal/full mode-toggle button group in the peek header. `peekModeBar`
// is the segmented track; `peekModeBtn` is one icon button; `peekModeBtnActive`
// marks the current mode. Mirrors the toolbar segmentTrack/segmentBtn shape so
// the two control groups read identically across the Tasks surface.
export const peekModeBar = "flex items-center gap-0.5 rounded-md bg-deeper p-0.5";
export const peekModeBtn =
  "grid size-6 place-items-center rounded-[4px] text-content-dim " +
  "transition-colors hover:bg-hover-gray";
export const peekModeBtnActive = "bg-dropdown-selected text-content";
export const peekHeader =
  "flex h-14 items-center justify-between border-b border-edge px-4 text-content";
export const tabBar = "flex gap-4 border-b border-edge px-4";
export const tabActive = "border-b-2 border-accent pb-2 text-content";
export const tabIdle = "pb-2 text-content-dim hover:text-content";
// Inline-editable property value cell in the peek/detail grid: clickable, hover
// hint, opens a dropdown.
export const peekValueCell =
  "flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-[13px] " +
  "text-content transition-colors hover:bg-hover-gray";

// ── INLINE-EDIT-IN-ROW (list view) ───────────────────────────────────────────
// Plane's list rows expose inline property controls (status / priority / due /
// assignee) RIGHT in the row — clicking one opens its dropdown without leaving
// the list. `inlineRowControl` is the per-property trigger inside a list row:
// quiet by default, hover-tinted, sized to sit on the 44px row. `inlineRowEdit`
// is the borderless inline title <input> shown when a row title is being renamed
// in place (commit on blur/Enter). Both stay token-only so dark+light match.
export const inlineRowControl =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[13px] " +
  "text-content-dim transition-colors hover:bg-hover-gray hover:text-content";
export const inlineRowEdit =
  "min-w-0 flex-1 rounded-[4px] bg-transparent px-1 py-0.5 text-[14px] text-content " +
  "outline-none ring-1 ring-accent placeholder:text-content-muted";

// ── SHARED ATOMS (geometry only; color comes from the helper passed in) ───────
// Priority dot — fill class comes from priorityStyle().dot (priority.ts).
export const priorityDot = "size-2 shrink-0 rounded-full";
// Due chip — color class comes from dueChipClass() (due.ts).
export const dueChip = "inline-flex items-center rounded-[4px] px-1.5 py-0.5 text-[13px]";

// ── SHARED WORK-ITEM PROPERTY ROW (Plane IssueProperties port) ───────────────
// FAITHFUL Plane all-properties.tsx reproduction. Each property is wrapped in a
// fixed `h-5` (20px) cell (all-properties.tsx 199,215,…) and renders as a small
// bordered pill/box. Plane geometry, ported EXACTLY (only COLOR is tokenized):
//   border-[0.5px]  -> border-[0.5px]   (keep Plane's hairline geometry verbatim)
//   border-strong   -> border-edge      (--border, our default hairline color)
//   rounded-sm      -> rounded-[4px]    (Plane rounded-sm = 4px)
//   bg-layer-2      -> bg-tasks-card-bg (the card/layer-2 surface token)
//   text-caption-*  -> text-[11px]      (Plane caption-sm/md ~11px)
// The priority box's border is priority-KEYED (Plane border-priority-*), so its
// border-color class is added at the call site via cn(); workPriorityBox carries
// only the geometry.
//
// workChipPill    — STATE/module/cycle pill: h-5, rounded-[4px], border-[0.5px],
//                   px-1.5, gap-1.5 (Plane BorderButton: buttons.tsx:84-90).
// workPriorityBox — PRIORITY box (border-without-text, hideText): h-5,
//                   rounded-[4px], border-[0.5px] colored, px-0.5, icon only
//                   (priority.tsx:91-101 +439).
// workAssigneeBox — UNASSIGNED placeholder (MemberDropdown border-without-text):
//                   the bordered h-5 SQUARE with a members icon, ALWAYS shown when
//                   no one is assigned (base.tsx:111-164 + avatar.tsx:56-60). h-5,
//                   rounded-[4px], border-[0.5px] border-strong, px-1.5.
// workCountChip   — sub-item / link / attachment count chip: h-5, rounded-[4px],
//                   border-[0.5px], px-2.5, py-1, gap-2 (all-properties.tsx:415).
// workLabelChip   — one bordered LABEL chip: a color dot + the label name.
// workLabelDot    — the 8px color dot ahead of a label name (fill set via cn()).
// workAvatarGroup — Plane AvatarGroup wrapper: flex -space-x-1 (md overlap).
// workAvatarRing  — per-avatar wrapper ring: rounded-full border border-subtle-1.
// Plane's main dropdown property pills (state/priority/date/assignee) render their
// label at text-body-xs-medium = 13px (dropdowns/priority.tsx:130), NOT the 11px
// caption size — only the numeric count chips (workCountChip) stay at 11px.
export const workChipPill =
  "inline-flex h-5 items-center gap-1.5 rounded-[4px] border-[0.5px] border-edge px-1.5 text-[13px]";
export const workPriorityBox =
  "inline-flex h-5 items-center justify-center gap-1.5 rounded-[4px] border-[0.5px] bg-tasks-card-bg px-0.5";
// Plane's MemberDropdown UNASSIGNED placeholder (border-without-text): a compact
// bordered square. Plane uses a thin SOLID border-[0.5px] border-strong (NOT
// dashed). The inner members icon is h-3 w-3 with mx-[4px] (avatar.tsx:59).
export const workAssigneeBox =
  "inline-flex h-5 items-center justify-center rounded-[4px] border-[0.5px] border-edge px-1.5 text-content-muted";
export const workCountChip =
  "inline-flex h-5 shrink-0 items-center justify-center gap-2 rounded-[4px] border-[0.5px] border-edge " +
  "px-2.5 py-1 text-[11px] text-content-muted";
export const workLabelChip =
  "inline-flex h-5 items-center gap-1.5 rounded-[4px] border-[0.5px] border-edge px-1.5 text-[11px] " +
  "text-content-dim";
export const workLabelDot = "size-2 shrink-0 rounded-full";
// Plane AvatarGroup (avatar-group.tsx:66-96): wrapper flex with md overlap
// -space-x-1; each avatar wrapped in a rounded-full ring (border border-subtle-1).
export const workAvatarGroup = "flex -space-x-1";
export const workAvatarRing = "rounded-full border border-edge bg-tasks-card-bg";

// ── CALENDAR LAYOUT ──────────────────────────────────────────────────────────
// Plane's calendar layout (calendar-chart): a month grid wrapped in a bordered
// canvas, a fixed weekday header row, and a 7-column body of day tiles. Each
// tile shows its day-number, a hover-revealed per-tile "+" add button, and a
// stack of small issue chips (a chip is a clickable mini-card that opens the
// peek). Today's tile highlights its day-number; out-of-month days dim. All
// surfaces map through the same tokens the board/list use, so dark + light both
// resolve. Geometry-only brackets (heights / today ring) carry NO color.
export const calContainer =
  "flex h-full flex-col overflow-hidden rounded-lg border border-edge bg-surface";
// Weekday header strip ("Sun … Sat") above the grid.
export const calWeekHeader =
  "grid grid-cols-7 border-b border-edge bg-surface-alt text-[12px] font-medium text-content-dim";
export const calWeekHeaderCell = "px-2 py-1.5 text-center";
// The scrollable month body: weeks stack vertically, days fill a 7-col grid.
export const calGrid = "grid flex-1 auto-rows-fr grid-cols-7 overflow-y-auto";
// One day tile. Right/bottom hairline borders build the grid lines; the `group`
// hook lets the per-tile add button reveal on hover. Vertical stack: number row
// then the chip stack.
export const calDayTile =
  "group flex min-h-[7rem] flex-col gap-1 border-b border-r border-edge bg-surface p-1.5 " +
  "transition-colors hover:bg-hover-gray";
// A day outside the current month — quieter surface + muted number.
export const calDayOutMonth = "bg-surface-alt text-content-muted";
// The day-number element in a tile's top row.
export const calDayNumber = "text-[12px] font-medium text-content-dim";
// Today's tile: the day-number becomes a filled accent pill.
export const calDayToday =
  "grid size-5 place-items-center rounded-full bg-accent text-[color:var(--brand-contrast)]";
// Hover-revealed per-tile quick-add ("+") button in the tile's top row.
export const calAddButton =
  "grid size-5 place-items-center rounded-[4px] text-content-muted opacity-0 transition " +
  "hover:bg-hover-gray hover:text-content focus-visible:opacity-100 group-hover:opacity-100";
// A single issue chip inside a day tile — Plane's calendar/issue-block.tsx is a
// full-width ControlLink `block w-full rounded-sm border-b border-subtle text-13
// hover:border-subtle-1 md:border-[1px]`: a bottom hairline that promotes to a
// full 1px border at md. We map `border-subtle` → border-edge, `border-subtle-1`
// → border-edge-light, and reproduce its geometry (rounded-[2px], full 1px
// border) at our dense desktop target.
export const calIssueChip =
  "block w-full rounded-[2px] border border-edge text-left text-[13px] text-content " +
  "transition-colors hover:border-edge-light";
// Plane's inner block div (`group/calendar-block flex h-10 ... md:h-8 md:px-1`):
// the dense desktop row — `flex h-8 w-full items-center justify-between gap-1.5
// rounded-sm px-1` over `bg-surface-1 hover:bg-surface-2` (→ surface-alt /
// hover-gray). The `group/calendar-block` hook reveals the quick-actions slot.
export const calIssueChipInner =
  "group/calendar-block flex h-8 w-full items-center justify-between gap-1.5 rounded-[2px] " +
  "bg-surface-alt px-1 py-1.5 transition-colors hover:bg-hover-gray";
// Plane's left cluster (`flex h-full items-center gap-1.5 truncate`): stripe + key
// + title, truncating as one.
export const calIssueChipLeft = "flex h-full items-center gap-1.5 truncate";
// The thin vertical STATE color stripe at the chip's leading edge (Plane's
// `span.h-full w-0.5 flex-shrink-0 rounded-sm` with inline backgroundColor=
// stateColor). Geometry only — the fill is a var(--state-*) inline style set at
// the call site. rounded-sm → rounded-[2px] (literal-fork geometry).
export const calIssueStripe = "h-full w-0.5 shrink-0 rounded-[2px]";
// The work-item KEY ahead of the title in a calendar chip (Plane's IssueIdentifier
// `size=xs variant=tertiary`). Quiet, single-line.
export const calIssueKey = "shrink-0 text-[11px] text-content-muted";
// The title text in a calendar chip — compact, single-line (Plane md `text-11
// font-regular`).
export const calIssueTitle = "min-w-0 flex-1 truncate text-[11px] text-content";
// Plane's hover-revealed quick-actions slot at the chip's right edge (`size-5
// flex-shrink-0` + `hidden group-hover/calendar-block:block`). Holds a
// MoreHorizontal trigger (`h-3.5 w-3.5`). Click stops propagation so it never
// opens the peek.
export const calIssueChipActions =
  "hidden size-5 shrink-0 place-items-center rounded-[2px] text-content-muted " +
  "transition-colors hover:bg-hover-gray hover:text-content group-hover/calendar-block:grid";
// While a chip is mid-drag (re-dating to another tile). Plane's dragging state on
// the inner block is `border-accent-strong bg-surface-2 shadow-raised-200`.
export const calIssueChipDragging = "z-[var(--z-elevated)] opacity-90";
// "+N more" affordance when a tile overflows its visible chip cap.
export const calMoreLink = "px-1.5 text-[12px] text-accent hover:underline";

// ── SPREADSHEET LAYOUT ───────────────────────────────────────────────────────
// Plane's spreadsheet layout (spreadsheet-view): a wide table that scrolls
// horizontally inside a bordered canvas. The first column (the issue title +
// id) is sticky-left so it stays visible while the property columns scroll. The
// header row sticks to the top; each header cell carries a sort-indicator slot
// and a right-edge resize-handle affordance. Body cells are inline-edit
// triggers (click a cell to open its property dropdown). Rows hover-tint.
export const sheetWrapper = "h-full overflow-auto rounded-lg border border-edge bg-surface";
export const sheetTable = "w-max min-w-full border-collapse text-[13px] text-content";
// Sticky header row.
export const sheetHeadRow =
  "sticky top-0 z-[var(--z-sticky)] bg-surface-alt text-[12px] font-medium text-content-dim";
// A property column header cell — relative so the resize handle can pin to its
// right edge; `group` reveals the handle on hover. Height tracks Plane's 44px
// (h-11) spreadsheet row so the header band aligns to the body rows.
export const sheetHeadCell =
  "group relative h-11 whitespace-nowrap border-b border-r border-edge px-3 text-left " +
  "transition-colors hover:bg-hover-gray";
// The sticky-left KEY column header (title/id) — pinned both top and left, so it
// must out-stack BOTH the scrolling header cells and the scrolling key cells.
// `--z-dropdown` is the lowest scale step above `--z-sticky`; the table is its
// own isolated stacking context, so this never collides with real dropdowns.
export const sheetHeadKeyCell =
  "sticky left-0 z-[var(--z-dropdown)] h-11 whitespace-nowrap border-b border-r border-edge " +
  "bg-surface-alt px-3 text-left";
// Inline sort-indicator glyph wrapper inside a header cell (asc/desc/none).
export const sheetSortIndicator = "ml-1 inline-flex text-content-muted";
// Column resize-handle affordance pinned to the header cell's right edge —
// hover-revealed, accent-tinted grab strip.
export const sheetResizeHandle =
  "absolute inset-y-0 right-0 w-1 cursor-col-resize bg-transparent opacity-0 transition " +
  "hover:bg-accent group-hover:opacity-100";
// ── SPREADSHEET ROW — LITERAL FORK of Plane's spreadsheet/issue-row.tsx ───────
// Plane's `<tr>` (issue-row.tsx:94) carries NO geometry: it is just the
// virtualized `bg-surface-1 transition-[background-color]` shell. `selected` adds
// the `selected-issue-row` group hook; `active` adds a strong border. The h-11 /
// hairlines / hover all live on the inner cell <Row>s, so we mirror that here.
//   bg-surface-1 -> bg-surface ; transition-[background-color] kept verbatim.
export const sheetRow = "group bg-surface transition-[background-color]";
// Plane marks a SELECTED row with `group selected-issue-row` (issue-row.tsx:98)
// so descendants can tint via `group-[.selected-issue-row]:*`. The active
// (border) state is `border-[0.5px] border-strong-1`.
//   border-strong-1 -> border-edge-light.
export const sheetRowSelected = "selected-issue-row";
export const sheetRowActive = "border-[0.5px] border-edge-light";
// A property body cell — Plane's IssueColumn <td> (issue-column.tsx:48):
// `h-11 min-w-36 border-r-[1px] border-subtle text-13` with an ::after BOTTOM
// hairline (`after:absolute after:bottom-[-1px] after:w-full after:border
// after:border-subtle`). The cell is effectively `p-0` — its Column editor owns
// the padding. We fork it exactly: real right hairline, min-w-36 (144px) floor,
// and the ::after bottom hairline so adjacent rows share one pixel line.
//   border-subtle -> border-edge ; text-13 -> text-[13px] (color from text-content).
export const sheetCell =
  "relative h-11 min-w-36 whitespace-nowrap border-r border-edge p-0 align-middle " +
  "text-[13px] after:pointer-events-none after:absolute after:bottom-[-1px] " +
  "after:left-0 after:w-full after:border-b after:border-edge";
// The sticky-left KEY body cell — Plane's first <td> (issue-row.tsx:267):
// `group/list-block relative left-0 z-10 max-w-lg bg-surface-1 md:sticky`. It is
// a bare positioning shell; the h-11 + borders + hover + peeked/scroll states all
// live on the inner <Row> (sheetKeyInner). `group/list-block` is Plane's
// hover-reveal hook for the select checkbox. Sticky from md up.
//   bg-surface-1 -> bg-surface ; md:sticky kept verbatim.
export const sheetKeyCell =
  "group/list-block relative left-0 z-[var(--z-sticky)] max-w-lg bg-surface align-middle md:sticky";
// The inner flex shell of the key cell — Plane's <Row> (issue-row.tsx:277):
// `group clickable z-10 flex h-11 w-full cursor-pointer items-center
// border-r-[0.5px] border-subtle-1 bg-transparent text-13`. The 44px height +
// RIGHT hairline live here; selected → `bg-accent-primary/5`; bottom hairline
// (`border-b-[0.5px]`) added unless peeked. We fork the static part; peeked /
// scrolled / selected states append at the call site.
//   border-subtle-1 -> border-edge ; bg-accent-primary/5 -> bg-dropdown-selected ;
//   text-13 -> text-[13px]. `group/key` keeps Plane's inner hover-reveal hook for
//   the quick-actions slot.
export const sheetKeyInner =
  "group/key relative z-[1] flex h-11 w-full cursor-pointer items-center border-b border-r " +
  "border-edge bg-transparent text-[13px] transition-colors group-hover:bg-hover-gray " +
  "group-[.selected-issue-row]:bg-dropdown-selected " +
  "group-[.selected-issue-row]:group-hover:bg-dropdown-selected";
// Peeked / active first-cell state — Plane swaps the bottom hairline for a full
// accent border (issue-row.tsx:281: `border border-accent-strong` when peeked).
//   border-accent-strong -> border-accent.
export const sheetKeyInnerPeeked = "border border-accent";
// Horizontal-scroll shadow on the frozen first cell — Plane's `shadow-[8px_22px_
// 22px_10px_rgba(0,0,0,0.05)]` cast when the sheet is scrolled sideways, so the
// pinned column reads as floating over the scrolled body.
export const sheetKeyInnerScrolled = "shadow-[8px_0_16px_-6px_rgba(0,0,0,0.18)]";
// Plane's hover-revealed multi-select checkbox slot — issue-row.tsx:312:
// `absolute left-1 mr-1 grid w-3.5 flex-shrink-0 place-items-center` holding a
// control that is `opacity-0 group-hover/list-block:opacity-100`. We fork the
// positioning + reveal hook; the box itself reuses checkBoxBase at the call site.
export const sheetKeySelect =
  "absolute left-1 z-[2] grid w-3.5 shrink-0 place-items-center opacity-0 transition-opacity " +
  "group-hover/list-block:opacity-100 focus-within:opacity-100";
// Plane's IDENTIFIER sub-section — issue-row.tsx:288:
// `flex h-full min-w-24 flex-shrink-0 items-center` with inner `text-11`. min-w-24
// matches; Plane's identifier is text-11 (we drop from text-12 to match). px-3
// keeps the key off the sticky cell's left edge (where the hover checkbox sits).
//   text-11 -> text-[11px] (color from text-content-muted).
export const sheetKeyIdentifier =
  "flex h-full min-w-24 shrink-0 items-center px-3 text-[11px] tabular-nums text-content-muted";
// Plane's WORK-ITEM sub-section — issue-row.tsx:305:
// `flex flex-grow items-center gap-0.5 py-2` with `min-w-60` WHEN the key shows,
// else `min-w-[360px]`. We fork BOTH widths: sheetKeyWorkItem is the with-key
// width; sheetKeyWorkItemNoKey is the no-key width, swapped in at the call site.
export const sheetKeyWorkItem = "flex h-full min-w-60 flex-grow items-center gap-0.5 py-2 pr-2";
export const sheetKeyWorkItemNoKey =
  "flex h-full min-w-[360px] flex-grow items-center gap-0.5 py-2 pr-2";
// Plane's sub-issue chevron slot — issue-row.tsx:343: `grid size-4 place-items-
// center`, a fixed 16px leading slot ahead of the title that holds the expand
// toggle when a row has sub-issues. This flat (ungrouped, no-expansion)
// spreadsheet has no sub-issue tree (matching TasksList), so the slot stays an
// empty spacer to keep the title column aligned element-for-element with Plane.
export const sheetKeyChevron = "grid size-4 shrink-0 place-items-center";
// The clickable title — Plane's title (issue-row.tsx:365): `h-full w-full
// cursor-pointer truncate pr-4 text-left text-13 text-primary focus:outline-none`.
// Forked verbatim (text-13, pr-4, truncate, text-left), keeping our focus-ring.
//   text-primary -> text-content ; text-13 -> text-[13px].
export const sheetKeyTitle =
  "h-full min-w-0 flex-1 cursor-pointer truncate pr-4 text-left text-[13px] text-content focus-ring";
// Plane's quick-actions custom button glyph — issue-row.tsx:225: a `MoreHorizontal
// h-3.5 w-3.5` inside `flex h-full w-full cursor-pointer items-center rounded-sm
// p-1 text-placeholder hover:bg-layer-1`, hover-revealed via `opacity-0 group-
// hover:opacity-100` (issue-row.tsx:374). We fork the glyph size + reveal intent.
//   text-placeholder -> text-content-muted ; bg-layer-1 -> bg-hover-gray ;
//   rounded-sm -> rounded-[4px].
export const sheetKeyAction =
  "grid h-full place-items-center rounded-[4px] p-1 text-content-muted opacity-0 transition " +
  "hover:bg-hover-gray hover:text-content focus-ring focus-visible:opacity-100 " +
  "group-hover/key:opacity-100 disabled:opacity-50 data-[state=open]:opacity-100";
// An inline-edit trigger filling a body cell — click to open the property
// dropdown. Plane lets each Column own its padding (the cell is `p-0`), so the
// trigger carries the inset. Quiet until hovered; mirrors inlineRowControl.
export const sheetCellTrigger =
  "flex h-full w-full items-center gap-1.5 px-3 text-left text-[13px] " +
  "text-content transition-colors hover:bg-hover-gray";

// ── GANTT LAYOUT ─────────────────────────────────────────────────────────────
// Plane's gantt layout (gantt-chart): a left sidebar listing each issue row
// aligned with a right-hand scrollable timeline. The timeline header is a
// two-tier ruler (month band over a day band). Each issue is a draggable bar
// positioned by its start/due dates, with grab handles on both edges for
// resizing (drag-left edits startDate, drag-right edits dueAt). A vertical
// today line marks the current date across the chart. Bar fill uses the accent
// token; geometry brackets (row height / today line width) carry NO color.
export const ganttWrapper = "flex h-full overflow-hidden rounded-lg border border-edge bg-surface";
// Frozen left sidebar listing the issue titles, aligned row-for-row to the bars.
export const ganttSidebar =
  "flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface-alt";
// The sidebar header cell, aligned to the ruler's height.
export const ganttSidebarHeader =
  "flex h-12 items-center border-b border-edge px-3 text-[12px] font-medium text-content-dim";
// One sidebar row (an issue title) — hover-tinted, clickable to open the peek.
// Height matches Plane's gantt BLOCK_HEIGHT (44px = h-11) so the sidebar rows
// line up row-for-row with the timeline lanes. Holds the work-item key + title +
// a trailing "{N} days" duration label.
export const ganttSidebarRow =
  "flex h-11 items-center gap-2 border-b border-edge px-3 text-[13px] text-content " +
  "transition-colors hover:bg-hover-gray";
// The work-item KEY ahead of the title in a sidebar row (Plane IssueIdentifier).
export const ganttSidebarKey = "shrink-0 text-[12px] text-content-muted";
// The trailing "{N} day(s)" duration label pinned to the sidebar row's right edge
// (Plane's `flex-shrink-0 text-13 text-secondary`).
export const ganttSidebarDuration = "shrink-0 text-[12px] text-content-dim";
// The scrollable timeline pane to the right of the sidebar.
export const ganttTimeline = "relative flex-1 overflow-auto bg-surface";
// The two-tier ruler header — sticks to the top while the timeline scrolls.
export const ganttRuler =
  "sticky top-0 z-[var(--z-sticky)] flex h-12 flex-col bg-surface-alt text-[12px] text-content-dim";
// The month band (top tier of the ruler).
export const ganttRulerMonth =
  "flex h-6 items-center border-b border-edge px-2 font-medium text-content-dim";
// A day cell in the day band (bottom tier of the ruler).
export const ganttRulerDay =
  "grid h-6 place-items-center border-r border-edge text-[11px] text-content-muted";
// One timeline row (background lane behind a bar), aligned to its sidebar row.
// Height matches Plane's gantt BLOCK_HEIGHT (44px = h-11).
export const ganttRow = "relative h-11 border-b border-edge";
// The draggable issue bar. Plane's gantt bar is `space-between relative flex
// h-full w-full cursor-pointer items-center rounded-sm` (the FULL 44px lane
// height — no inset, no shadow), with the state color as an inline backgroundColor
// (var(--state-*) at the call site). We position it absolutely (left/width set
// inline from the gantt math) and keep a `group` hook so OUR edge handles (a
// Cyborg7 interaction layer; Plane's handles live in a wrapping ChartDraggable)
// reveal on hover. rounded-sm → rounded-[2px] (literal-fork geometry).
export const ganttBar =
  "group absolute inset-y-0 flex h-full w-full cursor-pointer items-center overflow-hidden rounded-[2px]";
// The translucent wash sitting over the state-colored bar so the label reads on
// any hue (Plane's `absolute top-0 left-0 h-full w-full bg-surface-1/50` → our
// surface at ~50%).
export const ganttBarOverlay = "pointer-events-none absolute inset-0 rounded-[2px] bg-surface/50";
// The bar's truncated name label. Plane's label is `sticky w-auto flex-1 truncate
// overflow-hidden px-2.5 py-1 text-13` offset by `left=SIDEBAR_WIDTH` so the name
// stays readable while the bar scrolls under the frozen sidebar. The sticky-left
// offset is set inline at the call site to OUR sidebar width (not Plane's
// hardcoded 360). Sits above the wash.
export const ganttBarLabel =
  "sticky z-[1] w-auto flex-1 truncate overflow-hidden px-2.5 py-1 text-[13px] text-content";
// While the bar is mid-drag (moving along the timeline).
export const ganttBarDragging = "z-[var(--z-elevated)] opacity-90";
// The left / right resize-edge grab handles on a bar (drag-left → startDate,
// drag-right → dueAt). Hover-revealed slim grab strips. Sit above the state wash.
export const ganttBarHandle =
  "absolute inset-y-0 z-[2] w-1.5 cursor-col-resize bg-content/40 opacity-0 " +
  "transition group-hover:opacity-100";
export const ganttBarHandleStart = "left-0 rounded-l-[4px]";
export const ganttBarHandleEnd = "right-0 rounded-r-[4px]";
// The vertical "today" line spanning the timeline height.
export const ganttTodayLine = "pointer-events-none absolute inset-y-0 w-px bg-accent";

// ── SUB-NAV ROWS ─────────────────────────────────────────────────────────────
// Plane's left work-items sub-nav (the secondary in-pane nav listing the views:
// All / Active / Backlog, plus Cycles / Modules / Labels). One vertical list of
// quiet rows; the active row tints with the selected surface + accent text. Each
// row is icon + label, with an optional trailing count badge. Token-only, so
// dark + light both resolve through the same map the board/list use.
//   container surface  -> bg-surface-alt   (--bg-surface)
//   row idle txt       -> text-content-dim (--text-secondary)
//   row hover tint     -> bg-hover-gray    (--hover-gray)
//   row active tint    -> bg-dropdown-selected (--dropdown-selected)
//   row active txt     -> text-accent / text-content
//   count badge        -> bg-deeper + text-content-muted
export const subNav = "flex flex-col gap-0.5 p-2";
export const subNavRow =
  "group flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-[13px] text-content-dim " +
  "transition-colors hover:bg-hover-gray hover:text-content";
export const subNavRowActive = "bg-dropdown-selected text-content";
// Leading glyph slot in a sub-nav row.
export const subNavIcon = "grid size-4 shrink-0 place-items-center text-content-muted";
// The row label fills the remaining width and truncates.
export const subNavLabel = "min-w-0 flex-1 truncate";
// Trailing count badge ("12") pinned to the row's right edge.
export const subNavCount =
  "shrink-0 rounded-[4px] bg-deeper px-1.5 py-0.5 text-[11px] font-medium text-content-muted";

// ── LABEL CHIPS ──────────────────────────────────────────────────────────────
// A task LABEL chip — a small pill carrying a label's name. The color triad
// (bg / text / border) is the ONLY part that varies per label and is applied at
// the call site from the app.css --label-* palette (bg-label-<n>-bg
// text-label-<n>-text border-label-<n>-border, both themes resolve). `labelChip`
// is the geometry-only base (NO color — it comes from the triad classes); add a
// leading `labelChipDot` when the design wants a solid color dot ahead of the
// name instead of a tinted fill. `labelChipRemove` is the hover-revealed "×" on
// an editable chip (in the peek's label editor).
//   chip color triad   -> bg-label-*-bg / text-label-*-text / border-label-*-border
//   remove hover tint  -> hover:bg-hover-gray
export const labelChip =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
// Solid color dot ahead of a chip label — the fill (bg-label-*-text) is set at
// the call site; this is geometry only.
export const labelChipDot = "size-1.5 shrink-0 rounded-full";
// Hover-revealed remove "×" on an editable label chip.
export const labelChipRemove =
  "grid size-3.5 shrink-0 place-items-center rounded-full text-current opacity-60 " +
  "transition hover:bg-hover-gray hover:opacity-100";
// The "+ Add label" affordance that opens the label picker in the peek.
export const labelChipAdd =
  "inline-flex items-center gap-1 rounded-full border border-dashed border-edge-light " +
  "px-2 py-0.5 text-[11px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content";

// ── PROPERTY ROWS (peek detail sidebar) ──────────────────────────────────────
// Plane's issue-detail sidebar is a stack of PROPERTY ROWS: each row is a fixed
// leading icon + label (the property name, e.g. "State", "Priority", "Assignee")
// and a trailing inline EDITOR (a dropdown / date / member trigger) that fills
// the rest of the row. `propertyRow` is the row shell; `propertyIcon` +
// `propertyLabel` are the fixed left column; `propertyEditor` is the clickable
// inline-edit trigger that opens the property's control. Mirrors the peek's
// existing peekValueCell editor look so the two read identically.
//   row hover (none — editor owns hover) ; label col -> text-content-dim
//   icon            -> text-content-muted
//   editor idle/hover -> text-content + hover:bg-hover-gray
//   editor empty hint -> text-content-muted
export const propertyRow = "flex items-center gap-2 py-1.5 text-[13px]";
// Fixed leading icon for the property.
export const propertyIcon = "grid size-4 shrink-0 place-items-center text-content-muted";
// The property name — a fixed-width quiet label column.
export const propertyLabel = "w-24 shrink-0 text-content-dim";
// The inline-edit trigger filling the rest of the row — click to open the
// property's dropdown/picker. Quiet until hovered.
export const propertyEditor =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-[4px] px-2 py-1 text-content " +
  "transition-colors hover:bg-hover-gray";
// The "Empty" placeholder shown inside an editor with no value set.
export const propertyEditorEmpty = "text-content-muted";

// ── DETAIL: HORIZONTAL PROPERTY STRIP + SECTION HEADINGS ─────────────────────
// Plane's WIDE work-item view puts the primary properties (State · Priority ·
// Assignee · Start · Due) in a single HORIZONTAL strip directly under the title,
// then groups the rest under labeled sections ("Details", "Project structure").
// `propertyStrip` is that inline row — wraps to a second line on a narrow panel;
// `stripItem` is one inline editor cell inside it (reuses the same dropdown
// editors, just laid out inline instead of in a SidebarPropertyListItem row);
// `detailSectionLabel` is the small uppercase heading above each Properties
// sub-group. `detailReadingColumn` centers the body into a wide-but-bounded
// reading column (Plane's `px-9 py-5` page main) when the panel is full-screen.
//   strip surface (none — sits on the panel) ; item text -> text-content
//   section heading -> text-content-muted (matches menuSectionLabel/subItemHeader)
export const propertyStrip =
  "flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-edge/60 py-2.5";
export const stripItem = "flex min-w-0 items-center gap-1.5 text-[13px] text-content";
// The fixed leading icon + name on a strip item (quiet, like a property label).
export const stripItemLabel =
  "inline-flex items-center gap-1.5 text-[13px] font-medium text-content-muted";
// Small uppercase section heading inside the Properties block ("Details",
// "Project structure"). Mirrors menuSectionLabel / subItemHeader.
export const detailSectionLabel =
  "text-[13px] font-medium uppercase tracking-wide text-content-muted";
// The wide-but-bounded reading column for the full/wide layout — centers the
// body so it reads like Plane's page main instead of edge-to-edge.
export const detailReadingColumn = "mx-auto w-full max-w-5xl px-6 sm:px-10";

// ── SUB-ITEM ROWS (sub-tasks) ────────────────────────────────────────────────
// Plane's "Sub-issues" list inside the peek — a nested list of child tasks under
// the parent. Each row is a compact, indented version of a list row: a state
// dot, the child id, the title (clickable to open its own peek), and trailing
// inline property controls. `subItemHeader` is the collapsible section header
// with its count; `subItemRow` is one child row; `subItemAdd` is the "+ Add
// sub-issue" affordance at the bottom.
//   header / row txt   -> text-content / -dim
//   row hover tint     -> bg-hover-gray
//   id chip            -> text-content-muted
//   add affordance     -> text-accent
export const subItemHeader =
  "flex items-center gap-2 py-1.5 text-[13px] font-medium uppercase tracking-wide text-content-muted";
export const subItemRow =
  "group flex h-9 items-center gap-2 rounded-[4px] pl-4 pr-2 text-[13px] text-content " +
  "transition-colors hover:bg-hover-gray";
export const subItemId = "shrink-0 text-[13px] text-content-muted";
export const subItemTitle = "min-w-0 flex-1 truncate";
export const subItemProps = "flex shrink-0 items-center gap-1.5 text-content-muted";
export const subItemAdd =
  "flex items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-[13px] text-accent " +
  "transition-colors hover:bg-hover-gray";

// ── LINKS / ATTACHMENTS ROWS ─────────────────────────────────────────────────
// Plane's "Links" and "Attachments" sections in the peek — each a list of rows
// with a leading type icon, a name/url, a secondary meta line (host / size /
// added-by), and hover-revealed actions (open / copy / delete). `attachmentRow`
// is the row shell with the file-actions reveal hook (`group`); `attachmentMeta`
// is the dim secondary line; `attachmentActions` is the trailing hover-revealed
// action cluster; `attachmentAdd` is the upload / "+ Add link" affordance.
//   row hover tint     -> bg-hover-gray ; border -> border-edge
//   name txt           -> text-content ; meta -> text-content-muted
//   link url accent    -> text-accent
//   actions reveal     -> opacity-0 group-hover/group-focus-within:opacity-100
export const attachmentRow =
  "group flex items-center gap-2.5 rounded-[6px] border border-edge bg-surface-alt p-2 " +
  "text-[13px] text-content transition-colors hover:bg-hover-gray hover:border-edge-light";
// Leading type/file icon slot.
export const attachmentIcon =
  "grid size-8 shrink-0 place-items-center rounded-[4px] bg-deeper text-content-muted";
// The name / url column (stacks the primary name over the meta line).
export const attachmentBody = "flex min-w-0 flex-1 flex-col";
export const attachmentName = "truncate font-medium text-content";
// A link row's clickable URL — accent, underline on hover.
export const attachmentLink = "truncate text-accent hover:underline";
// The dim secondary meta line (host / size / added-by · date).
export const attachmentMeta = "truncate text-[13px] text-content-muted";
// Trailing hover-revealed action cluster (open / copy / delete). Stays in the
// DOM (focusable) but hidden until row hover/focus — mirrors the app's
// .file-actions pattern, expressed in token classes here.
export const attachmentActions =
  "flex shrink-0 items-center gap-1 opacity-0 transition-opacity " +
  "group-hover:opacity-100 group-focus-within:opacity-100";
// One quiet icon button inside the action cluster.
export const attachmentActionBtn =
  "grid size-6 place-items-center rounded-[4px] text-content-muted " +
  "transition-colors hover:bg-hover-gray hover:text-content";
// The upload drop-zone / "+ Add link" affordance under the list.
export const attachmentAdd =
  "flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-edge-light " +
  "px-3 py-2 text-[13px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content";

// ── COLLAPSIBLE SECTION (sub-items / links / attachments) ────────────────────
// Plane's issue-detail body groups Sub-work-items / Links / Attachments into
// COLLAPSIBLE sections: a full-width header carrying the section title, a count
// (or a sub-work-item progress fraction/bar), and a chevron that rotates when
// open; below it a slotted body that shows/hides. These tokens are the geometry
// + color for that header — the open/close state lives on the bits-ui
// Collapsible primitive (data-state), and the chevron rotation is a stateful
// class added at the call site. All token-only, so dark + light both resolve.
//   header txt          -> text-content-dim / hover text-content
//   header hover tint   -> bg-hover-gray
//   title weight        -> font-medium
//   count badge         -> bg-deeper + text-content-muted
//   progress track/fill -> bg-deeper / bg-accent
//   chevron             -> text-content-muted (rotates via stateful class)
// The collapsible header — a full-width tappable trigger row. The chevron sits
// first, then the title, then the count/progress cluster pushed to the right.
export const collapsibleHeader =
  "group flex w-full items-center gap-2 rounded-[4px] px-1.5 py-1.5 text-[13px] " +
  "font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content";
// Leading chevron glyph. The call site adds the rotate stateful class
// (rotate-90 when open) keyed off the primitive's data-state.
export const collapsibleChevron =
  "grid size-4 shrink-0 place-items-center text-content-muted transition-transform " +
  "duration-[var(--duration-fast)]";
// The section title fills the space between the chevron and the trailing cluster.
export const collapsibleTitle = "min-w-0 flex-1 truncate text-left";
// Trailing count/progress cluster pinned to the header's right edge.
export const collapsibleMeta = "flex shrink-0 items-center gap-2 text-content-muted";
// A "3" / "3/8" count badge in the meta cluster.
export const collapsibleCount =
  "rounded-[4px] bg-deeper px-1.5 py-0.5 text-[11px] font-medium text-content-muted";
// A thin progress track (for sub-work-items "5 of 8 done"). The fill width is
// set inline from the completion ratio at the call site.
export const collapsibleProgressTrack = "h-1 w-16 overflow-hidden rounded-full bg-deeper";
export const collapsibleProgressFill = "h-full rounded-full bg-accent transition-[width]";
// A quiet square icon button placed in the header's trailing `actions` slot (the
// per-section "+" add / upload affordance). Lives inside the meta cluster, not
// the trigger, so its own click doesn't toggle the section. Hover-tinted, sized
// to sit on the header row — mirrors the app's other quiet icon buttons.
export const collapsibleAddBtn =
  "grid size-6 shrink-0 place-items-center rounded-[4px] text-content-muted " +
  "transition-colors hover:bg-hover-gray hover:text-content focus-ring";
// The slotted section body shown when the section is open.
export const collapsibleBody = "pt-1";
