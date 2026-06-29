import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // Ship source maps so runtime errors in the packaged app (e.g. the
  // effect_update_depth_exceeded loop) map back to real component/source
  // locations in DevTools instead of minified `#_` frames. The app loads from
  // a local cyborg:// origin, so the maps stay inside the Electron bundle.
  build: { sourcemap: true },
});
