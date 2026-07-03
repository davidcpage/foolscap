import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fsApi } from "./vite-fs-plugin";

// The engine-import seam: the two engines are imported straight from their src/ (../core, ../interaction),
// which live outside this package, so widen server.fs.allow to the repo root.
// @tldraw/state is never imported here — it resolves transitively from core/node_modules (one copy).
// fsApi() adds the dev-server middleware that serves the filesystem (see vite-fs-plugin.ts).
export default defineConfig({
  plugins: [react(), fsApi()],
  server: {
    // Bind to loopback only. The fs middleware serves the repo's files and accepts unauthenticated
    // mutation/agent-spawn commands (see vite-fs-plugin.ts), so it must never be reachable off this
    // machine. Pinned here so a stray `--host` or a default-changing Vite upgrade can't expose it.
    host: "127.0.0.1",
    // ONE canonical port, never a silent fallback. IndexedDB is per-ORIGIN and the origin includes the
    // port — if Vite slid to 5174 because 5173 was busy, every board would open EMPTY (its data marooned
    // under the 5173 origin). strictPort turns that silent data-loss mode into a loud startup failure:
    // a second `npm run dev` now exits with "port is already in use" instead of becoming a 5174 twin.
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] },
  },
});
