// A stand-in for `claude -p --input-format stream-json --output-format stream-json` in session-host and
// session-proc tests: reads user messages on stdin, answers with an assistant line then a `result` line.
// Magic prompts steer the lifecycle:
//   "hang" — never answer (the busy bit stays true)
//   "die"  — exit(3) mid-conversation (a self-death, not a kill)
// Exits cleanly when stdin closes (what a real CLI child does when its owner goes away WITH the pipe —
// note the session host holds the pipe open across dev-server restarts, so this models direct ownership).

import process from "node:process";

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [] }) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== "user") continue; // a control_request never opens a turn
    const text = msg.message?.content?.[0]?.text ?? "";
    if (text.includes("die")) process.exit(3);
    if (text.includes("hang")) continue;
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] } }) + "\n",
      );
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: `echo: ${text}` }) + "\n");
    }, 25);
  }
});
process.stdin.on("end", () => process.exit(0));
