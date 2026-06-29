import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    serviceWorker: {
      // Don't let SvelteKit auto-register the push service worker. Under the
      // Electron `cyborg://app` origin, register() throws an uncaught TypeError
      // ("protocol not supported") on every boot. We register it manually from
      // the web-push helper, guarded to http(s) origins only (push is web-only;
      // Electron uses native notifications).
      register: false,
    },
  },
};

export default config;
