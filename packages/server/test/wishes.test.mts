/*
  Answers the assistant wanted and could not have.

  What is worth testing here is that wanting the same thing twice is one row
  with two votes rather than two rows. A list that grows a fresh entry every
  time the assistant hits the same wall is a list nobody reads, and nobody
  reading it is the whole failure this was built to fix.

  The matching that decides sameness is a model call, so this runs the
  fallback: no credential, exact names. The model path is the same function
  with a better opinion about which existing want this is.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/wishes.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import { wishForAnswer, wishedActions } from "../src/wishes.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

console.log("\n1. A want is recorded, not acted on");

const first = await wishForAnswer("Split in two", "This bullet is two achievements in one line.");
assert.equal(first.voted, false);
assert.equal(first.wish.votes, 1);
ok("the first time something is wanted it is a new row with one vote");

const listed = await wishedActions();
assert.equal(listed.length, 1);
assert.equal(listed[0]?.name, "Split in two");
ok("and it shows up on the list the admin page reads");

console.log("\n2. Wanting it again is a vote");

const again = await wishForAnswer("Split in two", "Two achievements again, under a different role.");
assert.equal(again.voted, true);
assert.equal(again.wish.votes, 2);
assert.equal((await wishedActions()).length, 1);
ok("the same want is one row with two votes, not two rows");

assert.equal(again.wish.why, "Two achievements again, under a different role.");
ok("and the reason is the latest telling, which is the one with the most cases behind it");

console.log("\n3. A different want is its own row");

await wishForAnswer("Merge with another role", "The same job is on the profile twice.");
const both = await wishedActions();
assert.equal(both.length, 2);
assert.deepEqual(
  both.map((one) => one.name),
  ["Split in two", "Merge with another role"],
);
ok("a want that is not the same thing is a separate row, most wanted first");

console.log("\n4. A want has to say something");

await assert.rejects(() => wishForAnswer("   ", "Nothing."), /what the answer would be called/i);
await assert.rejects(() => wishForAnswer("Something", "  "), /what it is for/i);
ok("a nameless want, or one with no reason, is refused rather than listed");

console.log(`\n${passed} passed, 0 failed`);
