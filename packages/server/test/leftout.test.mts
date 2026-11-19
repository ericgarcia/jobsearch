/*
  The lines an import kept back, gathered under their role.

  What is worth testing is that this is the same queue. A page that showed
  held-back lines but left their questions waiting would ask about them again
  through the assistant, which is the interrogation this was built to end —
  so the test is that answering here settles the question there.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/leftout.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import { addLeftOut, leaveLeftOut, leftOutLines } from "../src/leftOut.js";
import { enqueue, progress, waitingQuestions } from "../src/queue.js";
import * as profile from "../src/profile.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const role = await profile.addRole({ company: "MuffinLabs", title: "Principal Consultant" });
const other = await profile.addRole({ company: "Elsewhere", title: "Engineer" });

const held = [
  { text: "MuffinLabs offers:", why: "Heading for the company's list of services" },
  { text: "• AI/ML Engineering — from prototype to production", why: "Service the company sells, not something you did" },
  { text: "We charge by the deliverable, not the hour.", why: "The company's commercial terms, not work" },
];

await enqueue(
  held.map((one) => ({
    source: "import:1",
    note: `The import left this line out from MuffinLabs, because ${one.why}. Offer it back to them as it stands: “${one.text}”`,
    target: "bullet",
    target_id: role.id,
    field: "text",
    value: one.text,
  })),
);

/* A question of the ordinary kind, which must not be swept in with them. */
await enqueue([
  {
    source: "import:1",
    note: "These two roles overlap — were you doing both?",
    target: "role",
    target_id: other.id,
  },
]);

console.log("\n1. Held back, under the role they came from");

const groups = await leftOutLines();
assert.equal(groups.length, 1);
assert.equal(groups[0]?.company, "MuffinLabs");
assert.equal(groups[0]?.lines.length, 3);
ok("every line an import held back from a role is gathered under that role");

assert.equal(groups[0]?.lines[1]?.why, "Service the company sells, not something you did");
ok("and each one carries the reason it was held, so the judgement can be checked");

assert.equal(
  groups.some((group) => group.role_id === other.id),
  false,
);
ok("a question that is not a held-back line is left where it is");

console.log("\n2. Answering here settles the question there");

const before = await progress();
const line = groups[0]!.lines[0]!;
assert.equal((await addLeftOut(line.id)).added, true);

assert.equal(
  (await profile.listBullets()).some((one) => one.role_id === role.id && one.text === line.text),
  true,
);
ok("adding one puts it on the profile under its role");

assert.equal(
  (await waitingQuestions()).some((one) => one.id === line.id),
  false,
);
assert.equal((await progress()).settled, before.settled + 1);
ok("and settles its question, so the assistant does not ask about it again");

console.log("\n3. Leaving the rest out, in one answer");

const rest = (await leftOutLines())[0]!.lines.map((one) => one.id);
assert.equal(rest.length, 2);
assert.equal((await leaveLeftOut(rest)).settled, 2);
ok("the rest go in one answer rather than one question each");

assert.equal((await leftOutLines()).length, 0);
assert.equal((await progress()).settled, before.settled + 3);
ok("nothing is held back any more, and all three count as answered");

assert.equal(
  (await profile.listBullets()).filter((one) => one.role_id === role.id).length,
  1,
);
ok("and leaving them out put nothing on the profile");

console.log("\n4. A line whose role has gone");

await enqueue([
  {
    source: "import:2",
    note: "The import left this line out from Elsewhere, because A tagline. Offer it back to them as it stands: “Gone.”",
    target: "bullet",
    target_id: other.id,
    field: "text",
    value: "Gone.",
  },
]);
await profile.deleteRole(other.id);
assert.deepEqual(await leftOutLines(), []);
ok("has nowhere to be shown, so it is not shown rather than shown nowhere");

console.log(`\n${passed} passed, 0 failed`);
