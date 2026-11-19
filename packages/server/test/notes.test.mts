/*
  What the person has said about parts of their profile.

  Three things are worth pinning down.

  That a note reaches the review, because that is the whole point: the review
  asked for the Preact figures a month after being told they were under NDA,
  and a note nobody reads would change nothing.

  That the same thing said twice is one note, since a list of repetitions is
  a list nobody finishes.

  And that nothing which writes to an employer can read them. That one is
  checked against the source rather than the behaviour: the guarantee is that
  the resume, the letters and the application forms do not import this file,
  and a test of the wiring is the only kind that keeps holding when somebody
  adds a feature next year.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/notes.test.mts
*/

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { migrate } from "../src/db/client.js";
import { allNotes, forgetNote, keepNote, notesFor, notesForReview } from "../src/notes.js";
import { reviewPayload } from "../src/review.js";
import * as profile from "../src/profile.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const role = await profile.addRole({ company: "Preact", title: "Founding ML Engineer" });
const line = await profile.addBullet(role.id, "Built the ML behind a customer-success platform.");

console.log("\n1. A note hangs on the row it is about");

const kept = await keepNote({
  target: "role",
  target_id: role.id,
  note: "The customer numbers are under NDA and cannot go on the profile.",
  settles: "what scale did Preact run at",
});
assert.equal(kept.instead, false);
assert.equal(kept.note.target_id, role.id);
assert.equal(kept.note.settles, "what scale did Preact run at");
ok("it is kept against the role, with the question it closes");

assert.equal((await notesFor("role", { id: role.id })).length, 1);
assert.equal((await notesFor("bullet", { id: line.id })).length, 0);
ok("and belongs to that row rather than to the profile at large");

console.log("\n2. A note has to be about something");

await assert.rejects(() => keepNote({ target: "role", note: "No id given." }), /which one/i);
await assert.rejects(
  () => keepNote({ target: "role", target_id: role.id, note: "   " }),
  /what they told you/i,
);
ok("a note with no row, or nothing in it, is refused rather than filed");

console.log("\n3. The same thing said twice");

const again = await keepNote({
  target: "role",
  target_id: role.id,
  note: "The customer numbers are under NDA and cannot go on the profile.",
});
assert.equal(again.instead, true);
assert.equal((await notesFor("role", { id: role.id })).length, 1);
ok("updates the note instead of adding a second");

assert.equal(again.note.settles, "what scale did Preact run at");
ok("and keeps what the first telling settled, which the second did not repeat");

console.log("\n4. What the review is given");

await keepNote({
  target: "bullet",
  target_id: line.id,
  note: "This wording is deliberate; a recruiter asked about it once.",
});
const payload = await reviewPayload();

assert.ok(payload.includes("under NDA"), "a note about a role reaches the review");
assert.ok(payload.includes("what scale did Preact run at"), "and so does what it settles");
assert.ok(payload.includes("a recruiter asked about it"), "and a note about a line");
ok("the notes travel with the profile into the review");

/*
  The things a review must never be given. Not a rule about the prompt: these
  are simply never fetched, so this reads what is sent and checks they are
  not in it.
*/
await profile.updateProfile({
  name: "A Person",
  email: "someone@example.com",
  phone: "+1 555 0100",
});
const sent = await reviewPayload();
assert.ok(!sent.includes("someone@example.com"), "no email");
assert.ok(!sent.includes("555 0100"), "no phone");
ok("while the contact details are not, because they are never fetched");

console.log("\n5. Nothing that writes to an employer can read them");

const src = path.join(import.meta.dirname, "..", "src");
async function filesUnder(where: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(where, { withFileTypes: true })) {
    const full = path.join(where, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/* Everything that composes something an employer will read. */
const writing = [
  path.join(src, "resume.ts"),
  ...(await filesUnder(path.join(src, "layout"))),
  ...(await filesUnder(path.join(src, "apply"))),
];

const leaking: string[] = [];
for (const file of writing) {
  const text = await readFile(file, "utf8");
  if (/from "\.{1,2}\/(\.\.\/)*notes\.js"/.test(text)) leaking.push(path.relative(src, file));
}
assert.deepEqual(
  leaking,
  [],
  `these write what an employer reads and must not import notes: ${leaking.join(", ")}`,
);
ok("the resume, the layouts and the application paths do not import the notes at all");

console.log("\n6. Theirs to remove");

const all = await allNotes();
assert.equal((await forgetNote(all[0]!.id)).removed, true);
assert.equal((await allNotes()).length, all.length - 1);
ok("a note can be taken back, being their own account of their own history");

console.log("\n7. What a review is told about one row, bounded");

for (let n = 0; n < 9; n += 1) {
  await keepNote({ target: "role", target_id: role.id, note: `A separate thing number ${n}.` });
}
const forReview = (await notesForReview()).filter((one) => one.target_id === role.id);
assert.equal(forReview.length, 6);
ok("a row with nine notes sends six, so one role cannot fill the prompt");

console.log(`\n${passed} passed, 0 failed`);
