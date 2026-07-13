// ThreadView pill-union seam (F-H5/F-T5 residue): the pure union/dedup/sort extracted from NodeView.tsx
// (ThreadView) into src/pill-members.ts — once the site of the P4 reopen-by-pill bugs, previously untested.
// pill-members.ts is dependency-free, so it imports directly in node --test (no resolve hook / DOM needed).

import { test } from "node:test";
import assert from "node:assert/strict";

const { unionPillMembers } = await import("../src/pill-members.ts");

// A member with an OPEN session card on this board (a member:open edge). `over` flips it to an invite etc.
const edge = (sid, over = {}) => ({ edgeId: `edge:${sid}`, sid, name: sid.toUpperCase(), open: true, invited: false, ...over });

test("unionPillMembers: a durable roster member with no edge becomes a closed, reopenable pill", () => {
  const members = unionPillMembers([edge("a")], [{ sid: "b", name: "B" }]);
  const b = members.find((m) => m.sid === "b");
  assert.deepEqual(
    b,
    { edgeId: null, sid: "b", name: "B", open: false, invited: false },
    "a cardless roster member → CLOSED (open:false), NOT invited, no edgeId — clickable to reopen (P4)",
  );
});

test("unionPillMembers: an edge wins over the roster on a sid collision (no duplicate pill)", () => {
  const members = unionPillMembers([edge("a")], [{ sid: "a", name: "stale-roster" }]);
  assert.equal(members.filter((m) => m.sid === "a").length, 1, "deduped by sid");
  assert.deepEqual(members[0], edge("a"), "the live edge member is kept, the roster copy dropped");
});

test("unionPillMembers: invited (pending-invite edge) stays distinct from a cardless closed member", () => {
  const members = unionPillMembers(
    [edge("invitee", { open: false, invited: true })],
    [{ sid: "closed-member", name: "CM" }],
  );
  const invitee = members.find((m) => m.sid === "invitee");
  const closed = members.find((m) => m.sid === "closed-member");
  assert.equal(invitee.invited, true, "a non-member:open EDGE is a pending invite");
  assert.equal(closed.invited, false, "a cardless roster member is joined-but-closed, not an invite");
  assert.equal(closed.open, false);
});

test("unionPillMembers: sorted open-first so live pills lead", () => {
  const members = unionPillMembers(
    [edge("closed-edge", { open: false, invited: true }), edge("open-edge")],
    [{ sid: "cardless", name: "C" }],
  );
  assert.equal(members[0].sid, "open-edge", "the one open member sorts first");
  assert.deepEqual(members.map((m) => m.open), [true, false, false]);
});

test("unionPillMembers: an empty roster returns the edge members (open-sorted), an empty input → []", () => {
  const members = unionPillMembers([edge("a"), edge("b", { open: false, invited: true })], []);
  assert.deepEqual(members.map((m) => m.sid), ["a", "b"]);
  assert.deepEqual(unionPillMembers([], []), [], "no edges, no roster → no pills, not a throw");
});
