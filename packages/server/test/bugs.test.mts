/*
  Faults the assistant filed, with the state of the app attached.

  The part worth testing is the attachment. A report whose context came from
  the model would be worse than no report: it would send whoever reads it
  looking for a fault in the wrong place. So the test is that the card named
  in an occurrence is the card that was actually up, and that a report filed
  with nothing waiting says so rather than inventing one.

  The matching that spots the same fault twice is a model call, so this runs
  the fallback: no credential, exact titles.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/bugs.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import { bugReports, markFixed, reportBug } from "../src/bugs.js";
import { clearEdit, proposeEdit } from "../src/pending.js";
import * as profile from "../src/profile.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const role = await profile.addRole({ company: "A Company", title: "An Engineer" });
const line = await profile.addBullet(role.id, "A line that is on the profile.");

console.log("\n1. Filed with nothing waiting");

const quiet = await reportBug({
  title: "A tool said it had done something it had not",
  doing: "Storing an answer they gave in conversation",
  expected: "The answer on their profile",
  happened: "Nothing was stored and no error came back",
});
assert.equal(quiet.again, false);
assert.equal(quiet.bug.occurrences.length, 1);
assert.equal(quiet.bug.occurrences[0]?.context.card, null);
ok("says no card was waiting rather than inventing one");

console.log("\n2. Filed with a card on the screen");

await proposeEdit({
  target: "bullet",
  target_id: line.id,
  field: "text",
  action: "ask",
  value: "",
  why: "Is this right?",
  recommend: "drop",
});

const seen = await reportBug({
  title: "A card came back unanswered",
  doing: "Waiting for them to answer a proposal",
  expected: "To be told what they chose",
  happened: "The card went away with no answer recorded",
});

const card = seen.bug.occurrences[0]?.context.card;
assert.equal(card?.target, "bullet");
assert.equal(card?.target_id, line.id);
assert.equal(card?.action, "ask");
assert.equal(card?.recommend, "drop");
assert.deepEqual(card?.answers, ["use", "leave", "drop"]);
ok("the card in the report is the card that was up, read off the server");

assert.ok(seen.bug.occurrences[0]!.context.queue.settled >= 0);
ok("and where the queue stood, which the assistant was not asked for");

await clearEdit();

console.log("\n3. The same fault twice");

const again = await reportBug({
  title: "A card came back unanswered",
  doing: "Waiting again",
  expected: "To be told what they chose",
  happened: "The same thing, on a different line",
});
assert.equal(again.again, true);
assert.equal(again.bug.hits, 2);
assert.equal(again.bug.occurrences.length, 2);
ok("is one report that has happened twice, with both sightings kept");

assert.equal(again.bug.happened, "The same thing, on a different line");
ok("and the account is the latest telling, which has seen it twice");

assert.equal((await bugReports()).length, 2);
ok("while a different fault stays its own report");

console.log("\n4. Marked fixed, and back again");

assert.equal((await markFixed(again.bug.id)).ok, true);
assert.ok((await bugReports()).find((one) => one.id === again.bug.id)?.fixed_at);
ok("somebody can say it is dealt with and it leaves the open list");

const returned = await reportBug({
  title: "A card came back unanswered",
  doing: "Waiting once more",
  expected: "To be told what they chose",
  happened: "It happened again after being called fixed",
});
assert.equal(returned.bug.fixed_at, null);
assert.equal(returned.bug.hits, 3);
ok("and a fault that happens again is open again, whoever called it done");

console.log("\n5. A report has to say something");

await assert.rejects(
  () => reportBug({ title: " ", doing: "a", expected: "b", happened: "c" }),
  /one-line title/i,
);
await assert.rejects(
  () => reportBug({ title: "A title", doing: "a", expected: "b", happened: " " }),
  /what happened instead/i,
);
ok("a report with no title, or no account of what happened, is refused");

console.log(`\n${passed} passed, 0 failed`);
