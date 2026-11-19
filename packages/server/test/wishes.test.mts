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
import { clearEdit, proposeEdit } from "../src/pending.js";
import * as profile from "../src/profile.js";

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

console.log("\n5. A want with no card waiting keeps no case");

const bare = await wishForAnswer("Mark it unknown", "The date is wrong and no date is righter.");
assert.equal(bare.withCase, false);
assert.equal(bare.wish.cases.length, 0);
ok("nothing was on the screen, so there is nothing to snapshot and none is invented");

console.log("\n6. A case is taken off the card, not from the assistant");

const role = await profile.addRole({ company: "A Company", title: "An Engineer" });
const line = await profile.addBullet(
  role.id,
  "Built the thing and also ran the other thing, which is two achievements.",
);

await proposeEdit({
  target: "bullet",
  target_id: line.id,
  field: "text",
  action: "ask",
  value: "",
  why: "Two achievements in one line.",
  recommend: "use",
});

const withCase = await wishForAnswer("Split in two", "Two achievements in one line, again.", {
  wanted: "Split it after the first clause, leaving two lines under the same role.",
  expect: "That role has two lines where it had one, and neither repeats the other.",
});
assert.equal(withCase.withCase, true);

const kept = withCase.wish.cases[0]!;
assert.equal(kept.saw, "Built the thing and also ran the other thing, which is two achievements.");
ok("the case holds the line as it stood, read off the card rather than retyped");

assert.deepEqual(kept.shape, {
  target: "bullet",
  action: "ask",
  field: "text",
  answers: ["use", "leave", "drop"],
  recommended: "use",
  had_value: true,
});
ok("and the card's contract, which is what a test for this would be written against");

assert.match(kept.expect, /two lines/);
ok("and what should be true afterwards, which is the test it is waiting for");

await clearEdit();

console.log("\n7. Twelve cases, keeping the first and the newest");

for (let round = 0; round < 14; round += 1) {
  await proposeEdit({
    target: "bullet",
    target_id: line.id,
    field: "text",
    action: "ask",
    value: "",
    why: "Again.",
    recommend: "use",
  });
  await wishForAnswer("Split in two", "Again.", {
    wanted: `Round ${round}`,
    expect: `Round ${round} is split`,
  });
  await clearEdit();
}

const piled = (await wishedActions()).find((one) => one.name === "Split in two")!;
assert.equal(piled.cases.length, 12);
ok("a want keeps twelve cases however many times it comes up");

assert.match(piled.cases[0]!.wanted, /Round 13/);
ok("the newest is first, because those are the ones still happening");

assert.match(piled.cases.at(-1)!.wanted, /first clause/);
ok("and the first telling is kept whatever else goes, being usually the clearest");

assert.equal(piled.votes, 17);
ok("while the votes count every time, which is what says how much it is wanted");

console.log(`\n${passed} passed, 0 failed`);
