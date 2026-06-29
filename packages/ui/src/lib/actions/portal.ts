// Svelte action that relocates a node to `document.body` (or a chosen target)
// so a `position: fixed` overlay escapes any ancestor that establishes a
// containing block for fixed descendants — most commonly an ancestor with a
// non-`none` `transform` (e.g. PullToRefresh's `translateY(0)` on mobile).
// Without this, a `fixed inset-0` modal mounted inside such an ancestor is
// positioned/clipped relative to that ancestor's box instead of the viewport,
// so it can render off-screen / invisibly.
//
// Usage: <div class="fixed inset-0 …" use:portal> … </div>
export function portal(node: HTMLElement, target: HTMLElement | string = document.body) {
  let host: HTMLElement | null = null;

  function mount(t: HTMLElement | string): void {
    host = typeof t === "string" ? document.querySelector<HTMLElement>(t) : t;
    if (host) host.appendChild(node);
  }

  mount(target);

  return {
    update(t: HTMLElement | string) {
      mount(t);
    },
    destroy() {
      // Svelte removes the node on block teardown; guard in case it's already
      // detached so we never throw during unmount.
      if (node.parentNode) node.parentNode.removeChild(node);
    },
  };
}
