// Types for jupyter-host.js (plain ESM, runs under bare node + node --test). Hand-written so server-kernel.ts
// can import the sidecar manager without allowJs. Keep in sync with the exports in jupyter-host.js.

/** The live kernel-gateway rendezvous: where the gateway is + how to reach it (token stays server-side). */
export interface GatewayInfo {
  baseUrl: string; // e.g. http://127.0.0.1:<port>
  token: string; // the gateway auth token — server-side only
  pid: number; // the detached gateway process
  envLabel: string; // which Python env it runs in (repo .venv / conda / poetry / system)
  startedAt: number;
}

/** The detected Python env the gateway runs in. */
export interface PythonEnv {
  jupyter: string; // absolute path to the `jupyter` executable
  cwd: string; // where kernels run (repo root)
  label: string; // human description of the env source
}

/** Detect the Python env for `appDir` (repo `.venv` → conda → poetry → system). Throws if none is usable. */
export function detectPythonEnv(appDir: string, repoRoot?: string): PythonEnv;

/** Probe a gateway: true iff `GET {baseUrl}/api` answers 200 with the token. */
export function probeGateway(baseUrl: string, token: string, timeoutMs?: number): Promise<boolean>;

/** Ensure a gateway is live for this app checkout (probe → reclaim-stale → launch on demand) and return it. */
export function ensureGateway(appDir: string): Promise<GatewayInfo>;

/** Stop the gateway for this app checkout (kill the pid + clear the rendezvous). Idempotent. */
export function stopGateway(appDir: string): Promise<boolean>;
