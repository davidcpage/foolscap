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
    fs: { allow: [".."] },
  },
});
