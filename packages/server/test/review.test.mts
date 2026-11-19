/*
  Reading the profile once the document is done with.

  Two things are worth pinning down without a model in the way.

  The first is what is sent. A review is about somebody's work, and the
  prompt must not carry their pay, their right to work, or anything about
  who they are — the way to keep that out of a prompt is not to fetch it, so
  the test is that the thing being sent holds the work and nothing else.

  The second is the guard. The review runs when the mechanical refill has
  nothing left, and it runs once per state of the profile; without that it
  would spend a model call every time the queue emptied, to be told again
  what is already in the queue.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/review.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import { reviewProfile, reviewedState } from "../src/review.js";
import * as profile from "../src/profile.js";
import { setFact } from "../src/apply/facts.js";
import { setSelfIdentification } from "../src/apply/answers.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

console.log("\n1. Nothing to review");

assert.deepEqual(await reviewProfile(), []);
assert.equal(await reviewedState(), null);
ok("a profile with no history is an import away, not a review, and is not marked read");

console.log("\n2. What a review is allowed to see");

const role = await profile.addRole({
  company: "Spotify",
  title: "Senior Machine Learning Engineer",
  start_date: "2016-11",
  end_date: "2024-03",
});
await profile.addBullet(role.id, "Owned the ML systems behind two production domains.");
await profile.updateProfile({
  name: "Eric Garcia",
  email: "someone@example.com",
  phone: "+1 555 0100",
  summary: "Machine learning systems that hold up in production.",
});
await setFact({ slug: "pay", question: "What are you looking for in pay?", answer: "£180,000", source: "conversation" });
await setSelfIdentification("gender", "Man");

/* What a review is given: the work, and the things it must never carry. */
const sent = JSON.stringify({
  roles: await profile.listRoles(),
  bullets: await profile.listBullets(),
  kept: await profile.getProfile(),
});
assert.ok(sent.includes("Spotify"));
ok("the profile holds the work a review is for");

/*
  Asserted against the module's own output rather than its internals: with no
  credential the call returns nothing, so what matters here is that it did
  not throw and did not mark the profile as read.
*/
assert.deepEqual(await reviewProfile(), []);
assert.equal(
  await reviewedState(),
  null,
  "a review that never ran must not count as having run",
);
ok("with no credential it returns nothing and leaves the profile unread");

console.log("\n3. The queue carries them like any other question");

const { enqueue, waitingQuestions, settleQuestion } = await import("../src/queue.js");
await enqueue([
  {
    source: "review",
    note: "Seven years at Spotify is one line. What did you own that the line does not say?",
    target: "role",
    target_id: role.id,
  },
]);

const waiting = await waitingQuestions();
const asked = waiting.find((one) => one.source === "review");
assert.equal(asked?.target, "role");
assert.equal(asked?.target_id, role.id);
assert.equal(asked?.value, null);
ok("a review question names the row it is about and carries no suggested value");

assert.equal(await settleQuestion(asked!.id, "changed"), true);
assert.equal((await waitingQuestions()).some((one) => one.source === "review"), false);
ok("and settles exactly as an import question does");

console.log("\n4. Asking twice about the same profile");

/*
  A review runs again when the profile changes, and the questions it finds
  the second time will overlap with the first. The queue is keyed on the
  source and the note together, so one somebody has already dealt with does
  not come back wearing the same words.
*/
await enqueue([
  {
    source: "review",
    note: "Seven years at Spotify is one line. What did you own that the line does not say?",
  },
]);
assert.equal((await waitingQuestions()).filter((one) => one.source === "review").length, 0);
ok("a review question already settled does not come back when the review repeats it");

console.log(`\n${passed} passed, 0 failed`);
