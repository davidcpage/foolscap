// The session-host's ONE shared Codex app-server runtime. This is deliberately a small adapter around
// codex-app-server + codex-session-router: session-host.js owns canvas-session lifecycle and its socket;
// this module owns Codex initialization, the ChatGPT-billing guard, and thread/turn calls.

import { spawnCodexAppServer } from "./codex-app-server.js";
import { createCodexSessionRouter } from "./codex-session-router.js";

export async function createCodexHostRuntime({ cwd, onEvent, onClose, spawnServer = spawnCodexAppServer }) {
  const server = spawnServer({ cwd });
  let intentionalClose = false;
  const router = createCodexSessionRouter({
    client: server,
    onEvent,
    // The first live slice runs workspace-confined with approvalPolicy:"never". A server request is
    // therefore unexpected and must fail closed until the canvas approval bridge lands.
    onRequest: async (_sid, message) => {
      throw new Error(`unsupported Codex server request ${message.method}`);
    },
  });
  server.onClose((reason) => {
    if (!intentionalClose) onClose(reason);
  });

  try {
    await server.ready;
    const accountResult = await server.request("account/read", { refreshToken: true });
    const account = accountResult?.account;
    if (account?.type !== "chatgpt") {
      const actual = account?.type ?? (accountResult?.requiresOpenaiAuth ? "not logged in" : "unknown");
      throw new Error(`Codex app-server requires ChatGPT login; refusing account type ${actual}`);
    }

    const threadSpec = (spec) => ({
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.developerInstructions ? { developerInstructions: spec.developerInstructions } : {}),
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });

    return {
      pid: server.pid,
      account: { type: account.type, email: account.email ?? null, planType: account.planType },
      start: (sid, spec) => router.start(sid, threadSpec(spec)),
      resume: (sid, providerSessionId, spec) => router.resume(sid, providerSessionId, threadSpec(spec)),
      prompt: (sid, text) => router.prompt(sid, text),
      steer: (sid, text) => router.steer(sid, text),
      interrupt: (sid) => router.interrupt(sid),
      read: (sid) => router.read(sid, true),
      release: (sid) => router.release(sid),
      close() {
        intentionalClose = true;
        router.close();
        server.kill();
      },
    };
  } catch (err) {
    intentionalClose = true;
    router.close();
    server.kill();
    throw err;
  }
}
