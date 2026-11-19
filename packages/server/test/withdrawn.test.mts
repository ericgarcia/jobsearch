/*
  A proposal that leaves the slot without being answered.

  The assistant learns an outcome one way only: the person clicks, and the
  page says so in their voice. Every other way out of the slot was silent.
  So when a pending edit was deleted from under a waiting assistant — in the
  case that prompted this, twice from a browser console — the assistant saw
  its card go and no answer arrive, could not tell that from a fault in the
  app, and told the person the box had disappeared without recording an
  answer. It was right about what it saw and wrong about what it meant.

  What is tested here is that a withdrawal leaves a trace the assistant can
  read, that its own withdrawals leave none, and that the trace does not
  outlive its usefulness.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/withdrawn.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import * as profile from "../src/profile.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const pending = await import("../src/pending.js");
const { clearEdit, pendingEdit, proposeEdit, resolveEdit } = pending;

console.log("\n1. A proposal taken away unanswered leaves a trace");

assert.equal(
  typeof (pending as Record<string, unknown>).withdrawnEdit,
  "function",
  "a proposal cleared out from under a waiting assistant must leave something it can read",
);
const { withdrawnEdit } = pending;

await profile.updateProfile({ name: "Eric Garcia", headline: null });

await proposeEdit({
  target: "profile",
  field: "headline",
  value: "PhD ML Engineer · Production ML, LLMs & Agents",
  why: "From the headline on the LinkedIn PDF you gave me.",
});

/* What DELETE /api/pending-edit does: the card goes, nobody answered. */
await clearEdit("elsewhere");

assert.equal(await pendingEdit(), null);
const taken = await withdrawnEdit();
assert.equal(taken?.field, "headline");
assert.equal(taken?.target, "profile");
assert.equal(taken?.by, "elsewhere");
assert.match(taken?.value ?? "", /PhD ML Engineer/);
ok("the withdrawal says which proposal went, and that the assistant did not do it");

assert.equal((await profile.getProfile()).headline, null);
ok("and nothing was stored, as for any unanswered proposal");

console.log("\n2. Its own withdrawals leave nothing to be told");

await proposeEdit({
  target: "profile",
  field: "location",
  value: "Boise, Idaho",
  why: "From the same document.",
});
await clearEdit("assistant");

assert.equal(await withdrawnEdit(), null);
ok("withdraw_edit leaves no trace: the assistant already knows it did that");

console.log("\n3. A better version of the same line is not a withdrawal");

await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer",
  why: "Shorter.",
});
await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer · agents and production systems",
  why: "You asked me to make it better.",
});
assert.equal(await withdrawnEdit(), null);
ok("replacing a proposal about the same field reports no withdrawal");

console.log("\n4. The trace is reported once, where the assistant is already looking");

await clearEdit("elsewhere");
const next = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer",
  why: "Trying again.",
});
assert.equal(next.withdrawn?.field, "headline");
assert.equal(next.withdrawn?.by, "elsewhere");
ok("the next proposal carries it, so the assistant finds out without looking it up");

assert.equal(await withdrawnEdit(), null);
ok("and it is cleared by that proposal, so it is not told twice");

console.log("\n5. An answer is not a withdrawal");

await clearEdit("elsewhere");
assert.notEqual(await withdrawnEdit(), null);
await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer",
  why: "Once more.",
});
await resolveEdit("use");
assert.equal(await withdrawnEdit(), null);
assert.equal((await profile.getProfile()).headline, "ML engineer");
ok("answering clears the trace: the answer is the outcome the assistant is told");

console.log("\n6. Clearing an empty slot does not erase the record");

/*
  The case this exists for deleted the pending edit twice. The second delete
  had nothing to take, and must not take the trace left by the first.
*/
await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer · agents",
  why: "Last one.",
});
await clearEdit("elsewhere");
await clearEdit("elsewhere");
assert.equal((await withdrawnEdit())?.field, "headline");
ok("a second withdrawal with nothing to take leaves the first one readable");

console.log(`\n${passed} checks passed.`);
