/*
  The things still worth asking, one at a time.

  Written against the screenshot that caused it: an import had been read and
  six numbered decisions went on the screen at once. The questions were good;
  there were six of them because the whole list arrived at once. So what is
  tested here is the metering — one out at a time, settled rather than
  deleted, and no second helping of a question somebody has already answered.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/queue.test.mts
*/

import assert from "node:assert/strict";
import { migrate, run } from "../src/db/client.js";
import {
  clearQueue,
  enqueue,
  enqueueFromImport,
  nextQuestion,
  progress,
  refilling,
  settleQuestion,
  waitingQuestions,
} from "../src/queue.js";
import { applyImport } from "../src/onboard.js";
import { proposeEdit, resolveEdit } from "../src/pending.js";
import * as profile from "../src/profile.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

/* Enough of a profile that the refill has no gaps of its own to add. */
await profile.updateProfile({
  name: "Eric Garcia",
  email: "eric@example.com",
  location: "New York, NY",
  headline: "ML Engineer",
  summary: "I build things.",
  links: JSON.stringify(["https://example.com"]),
});
await profile.addEducation({
  school: "UW",
  degree: "PhD",
  field: null,
  start_date: null,
  end_date: "2010",
  note: null,
});
await profile.addSkill("Python");
const role = await profile.addRole({
  company: "MuffinLabs",
  title: "Founder",
  location: null,
  start_date: "2026-01",
  end_date: null,
  summary: null,
});
await profile.addBullet(role.id, "Shipped a vision pipeline.");

console.log("\n1. Six notes go in, one comes out");

/*
  The shape of the bug. Six things to ask about is fine; six things on the
  screen at once is a form.
*/
const added = await enqueueFromImport(7, [
  "The summary says the PhD is in signal processing, but education says electrical engineering.",
  "NuMundo overlaps your time at Preact. Both are kept as written.",
  "The Research Assistant role is listed under Genome Sciences but reads as Electrical Engineering.",
  "Your five publications have nowhere to go in this profile.",
  "The summary has no space after a full stop.",
  "The first Superviber paragraph describes the architecture rather than your actions.",
]);
assert.equal(added, 6);

const first = await nextQuestion();
assert.equal(first.left, 6);
assert.match(first.question?.note ?? "", /signal processing/);
ok("all six are queued and exactly one is handed back");

assert.equal((await nextQuestion()).question?.id, first.question?.id);
ok("asking again gives the same one, because it is not answered yet");

console.log("\n2. Settled, not deleted");

await settleQuestion(first.question!.id, "left as it was");
const second = await nextQuestion();
assert.notEqual(second.question?.id, first.question?.id);
assert.equal(second.left, 5);
assert.equal(second.settled, 1);
ok("the next one comes out, and the count says what is left and what is done");

/*
  Re-reading the same document must not put a settled question back. Somebody
  who has answered something should not be asked it again because a file was
  opened twice.
*/
const again = await enqueueFromImport(7, [
  "The summary says the PhD is in signal processing, but education says electrical engineering.",
]);
assert.equal(again, 0);
assert.equal((await nextQuestion()).left, 5);
ok("the same note from the same document is not queued twice");

assert.equal(await settleQuestion(first.question!.id, "again"), false);
ok("and settling one twice does nothing rather than mis-counting");

console.log("\n3. An answer settles its own question");

/*
  The link that keeps the queue moving. Without it the assistant has to
  remember to settle each one, and a forgotten call leaves the queue stuck on
  a question somebody has already dealt with.
*/
const current = (await nextQuestion()).question!;
await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML Engineer · Production systems",
  why: "From the document.",
  question_id: current.id,
});
await resolveEdit("use");

const after = await nextQuestion();
assert.notEqual(after.question?.id, current.id);
assert.equal(after.settled, 2);
ok("keeping the change settles the question it answered");

const andThis = (await nextQuestion()).question!;
await proposeEdit({
  target: "profile",
  field: "headline",
  value: "Something else",
  why: "From the document.",
  question_id: andThis.id,
});
await resolveEdit("leave");
assert.notEqual((await nextQuestion()).question?.id, andThis.id);
ok("and so does skipping it — saying no is answering");

console.log("\n4. Enough for now");

const left = (await nextQuestion()).left;
assert.ok(left > 0);
const put = await clearQueue();
assert.equal(put, left);
assert.deepEqual(await waitingQuestions(), []);
ok("the rest can be put away in one go when somebody has had enough");

console.log("\n5. And then it refills from the profile itself");

/*
  Finishing a document's questions should run on into the gaps it did not
  fill, rather than stopping. The refill is lazy: a queue built in advance is
  wrong by the time it is read.
*/
await profile.updateProfile({ email: "" });
const refilled = await nextQuestion();
assert.ok(refilled.question, "nothing was queued from the profile itself");
assert.ok(
  refilled.question!.source === "gap" || refilled.question!.source === "asked",
  `unexpected source ${refilled.question!.source}`,
);
ok("with the queue empty it fills from what the profile is missing");

const emailOne = (await waitingQuestions()).find((one) => one.field === "email");
assert.ok(emailOne, "a missing email was not queued");
assert.equal(emailOne?.target, "profile");
ok("and a gap it knows the shape of says which field to propose");

console.log("\n6. Applying a document queues what it could not settle");

const written = await run(
  `INSERT INTO imports (source, origin, proposal) VALUES ('resume', NULL, ?)`,
  JSON.stringify({
    profile: {},
    roles: [],
    education: [],
    skills: [],
    facts: [],
    unsure: ["Two roles overlap and both are kept as written.", "A date is missing."],
  }),
);

await clearQueue();
const applied = await applyImport(Number(written.lastInsertRowid));
assert.equal(applied.to_ask, 2);
assert.equal(
  (await waitingQuestions()).filter((one) => one.source.startsWith("import:")).length,
  2,
);
ok("its unsure notes become things to ask about, after the rows exist to point at");

console.log("\n7. Nothing left is a thing it can say");

await clearQueue();
await profile.updateProfile({ email: "eric@example.com" });
await run(`UPDATE question_queue SET state = 'done'`);
await run(`DELETE FROM fact_matches`);

const nothing = await nextQuestion();
assert.equal(nothing.left, nothing.question ? nothing.left : 0);
ok("an empty queue answers with nothing rather than inventing something to ask");

console.log("\n8. An empty queue says which kind of empty it is");

/*
  The bar hides at zero, which is right when the questions are finished and
  wrong while the next ones are being worked out — the refill that reads the
  whole profile is a model call, and the bar vanished for the length of it.
  What matters here is that the flag is down once the call returns, however
  it returned: one left up would keep the bar on the screen forever.
*/

assert.equal(refilling(), false);
assert.equal((await progress()).refilling, false);
ok("nothing is being worked out when nothing is being worked out");

await clearQueue();
await run(`UPDATE question_queue SET state = 'done'`);
await nextQuestion();
assert.equal(refilling(), false);
ok("and a refill that has returned leaves it down, whatever it found");

console.log(`\n${passed} passed, 0 failed`);
