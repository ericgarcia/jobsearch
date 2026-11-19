/*
  One change at a time, and nothing stored by proposing it.

  The thing worth testing here is the refusal. Onboarding kept arriving as a
  numbered list of six decisions because nothing stopped it; the single slot
  is what stops it, so the test that matters is that a second proposal cannot
  get in while the first is waiting.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/pending.test.mts
*/

import assert from "node:assert/strict";
import { get, migrate } from "../src/db/client.js";
import { clearEdit, pendingEdit, proposeEdit, resolveEdit } from "../src/pending.js";
import * as profile from "../src/profile.js";
import { getFact, setFact } from "../src/apply/facts.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

console.log("\n1. Proposing stores nothing");

await profile.updateProfile({ name: "Eric Garcia", headline: null });

const first = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "PhD ML Engineer · Production ML, LLMs & Agents",
  why: "From the headline on the LinkedIn PDF you gave me.",
});

assert.equal(first.waiting, undefined);
assert.equal((await profile.getProfile()).headline, null);
ok("the profile is untouched while a proposal is on screen");

const waiting = await pendingEdit();
assert.equal(waiting?.field, "headline");
assert.match(waiting?.why ?? "", /LinkedIn PDF/);
ok("and the proposal says what it is and where it came from");

assert.equal(waiting?.current, null);
await profile.updateProfile({ headline: "Something they typed" });
assert.equal((await pendingEdit())?.current, "Something they typed");
ok("it carries what is stored now, so the page can show it as a change");

console.log("\n2. There is one slot, and it is the mechanism");

/*
  The whole design. An assistant with six things to ask about gets told to
  finish the first, rather than putting six on the screen — which is what it
  did when nothing stopped it.
*/
const second = await proposeEdit({
  target: "profile",
  field: "location",
  value: "New York, NY",
  why: "From the same document.",
});

assert.equal(second.waiting?.field, "headline");
assert.equal((await pendingEdit())?.field, "headline");
ok("a second proposal is refused and the first is handed back");

assert.equal((await profile.getProfile()).location, null);
ok("and the one that was refused stored nothing either");

console.log("\n3. Their answer is the only thing that writes");

const kept = await resolveEdit("use");
assert.equal(kept.kept, true);
assert.equal(kept.edited, undefined);
assert.equal((await profile.getProfile()).headline, "PhD ML Engineer · Production ML, LLMs & Agents");
ok("keeping it stores what was proposed");

assert.equal(await pendingEdit(), null);
ok("and the slot is free again");

console.log("\n4. Editing before keeping is just typing");

/*
  What gets stored is whatever is in the box when they click, so a correction
  needs no second round trip — and the assistant never learns to write their
  prose, because it did not write this.
*/
await proposeEdit({
  target: "profile",
  field: "location",
  value: "New York, United States",
  why: "From the document.",
});
const edited = await resolveEdit("use", "Brooklyn, NY");

assert.equal(edited.kept, true);
assert.equal(edited.edited, true);
assert.equal((await profile.getProfile()).location, "Brooklyn, NY");
ok("their text wins over the proposed one, and the answer says it was changed");

console.log("\n5. Skipping leaves what was there");

await profile.updateProfile({ email: "eric@example.com" });
await proposeEdit({
  target: "profile",
  field: "email",
  value: "someone.else@example.com",
  why: "The document lists this one.",
});
const skipped = await resolveEdit("leave");

assert.equal(skipped.kept, false);
assert.equal(skipped.value, undefined);
assert.equal((await profile.getProfile()).email, "eric@example.com");
ok("nothing is written, and what they had stands");

console.log("\n6. A job, a line under it, and a stored answer");

const role = await profile.addRole({
  company: "MuffinLabs",
  title: "Founder",
  location: null,
  start_date: "2026-01",
  end_date: null,
  summary: null,
});
const line = await profile.addBullet(role.id, "We charge by the deliverable, not the hour.");
const real = await profile.addBullet(role.id, "Shipped a vision pipeline for a biotech client.");

await proposeEdit({
  target: "role",
  target_id: role.id,
  field: "title",
  value: "Founder & Principal Consultant",
  why: "The PDF gives the longer title.",
});
assert.equal((await pendingEdit())?.current, "Founder");
await resolveEdit("use");
assert.equal((await profile.listRoles()).find((one) => one.id === role.id)?.title, "Founder & Principal Consultant");
ok("a job's title is proposed, shows what it is now, and is stored when kept");

/*
  The case this was widened for. An export put a company's sales copy among
  somebody's achievements, and the choice was to import it and tidy up later
  or lose the whole role.
*/
await proposeEdit({
  target: "bullet",
  target_id: line.id,
  field: "text",
  value: "",
  why: "This is what the business charges, not something you did.",
  action: "delete",
});
const removed = await resolveEdit("use");
assert.equal(removed.removed, true);
assert.deepEqual(
  (await profile.listBullets(role.id)).map((one) => one.text),
  ["Shipped a vision pipeline for a biotech client."],
);
ok("a line that is not an achievement is removed, and the real one stays");

await proposeEdit({
  target: "bullet",
  target_id: real.id,
  field: "text",
  value: "Shipped a vision pipeline for a biotech client.",
  why: "It is in the present tense elsewhere; change it here if you want.",
});
await resolveEdit("use", "Shipped a vision pipeline for a biotech imaging client.");
assert.deepEqual(
  (await profile.listBullets(role.id)).map((one) => one.text),
  ["Shipped a vision pipeline for a biotech imaging client."],
);
ok("and a line they want reworded is reworded by them, not proposed rewritten");

await setFact({ slug: "notice_period", question: "What notice do you have to give?", answer: "One month" });
await proposeEdit({
  target: "fact",
  target_key: "notice_period",
  field: "answer",
  value: "Three months",
  why: "You said three months just now.",
});
assert.equal((await pendingEdit())?.current, "One month");
await resolveEdit("use");
const fact = await getFact("notice_period");
assert.equal(fact?.answer, "Three months");
assert.equal(fact?.question, "What notice do you have to give?");
ok("a stored answer is updated and keeps the question later forms are matched against");

await proposeEdit({
  target: "fact",
  target_key: "notice_period",
  field: "answer",
  value: "",
  why: "You said this is not something you want on file.",
  action: "delete",
});
await resolveEdit("use");
assert.equal(await getFact("notice_period"), null);
ok("and one they do not want on file is removed");

console.log("\n6b. What cannot be proposed");

await assert.rejects(
  () => proposeEdit({ target: "profile", field: "links", value: "x", why: "y" }),
  /not one of the fields/i,
);
ok("a field that is not on the list is refused by name");

await assert.rejects(
  () => proposeEdit({ target: "layout", field: "company", value: "x", why: "y" }),
  /Nothing can be proposed/i,
);
ok("and so is a target that is not wired up");

await assert.rejects(
  () => proposeEdit({ target: "profile", field: "name", value: "A Name", why: "   " }),
  /Say why/i,
);
ok("a proposal with no reason is refused, since the reason is shown to them");

await assert.rejects(
  () => proposeEdit({ target: "role", field: "title", value: "x", why: "y" }),
  /named by its id/i,
);
await assert.rejects(
  () => proposeEdit({ target: "fact", field: "answer", value: "x", why: "y" }),
  /named by its topic/i,
);
ok("and one that does not say which role or which answer cannot be made at all");

await assert.rejects(
  () => proposeEdit({ target: "profile", field: "name", value: "x", why: "y", action: "delete" }),
  /cannot be removed/i,
);
ok("their name can be changed but not deleted, since there is no row to remove");

await assert.rejects(
  () => proposeEdit({ target: "profile", field: "name", value: "  ", why: "y" }),
  /Nothing to set/i,
);
ok("and an empty value is refused rather than quietly clearing a field");

console.log("\n7. Taking one back, and answering one that is not there");

await proposeEdit({ target: "profile", field: "phone", value: "555", why: "From the document." });
await clearEdit("assistant");
assert.equal(await pendingEdit(), null);
assert.equal((await profile.getProfile()).phone, null);
ok("withdrawing removes it and stores nothing");

await assert.rejects(() => resolveEdit("use"), /Nothing is waiting/i);
ok("and answering nothing says so rather than writing something");

console.log("\n8. The slot is a slot, in the table");

await proposeEdit({ target: "profile", field: "name", value: "Eric Garcia", why: "From the document." });
const rows = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_edit`);
assert.equal(rows?.n, 1);
await clearEdit("assistant");
assert.equal((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_edit`))?.n, 0);
ok("one row at most, which is what makes one question at a time structural");

console.log("\nA second thought about the line they are looking at");

/*
  The request the one-slot rule used to make impossible: they look at a
  proposed line and ask for a better one. Replacing it is not a second
  question, and refusing left the assistant with nothing to do but describe
  the edits it would have made.
*/
await clearEdit("assistant");
const role2 = await profile.addRole({
  company: "Superviber",
  title: "Founder",
  location: null,
  start_date: "2026-01",
  end_date: null,
  summary: null,
});
const openLine = await profile.addBullet(role2.id, "A long line that reads like a product description.");

const firstGo = await proposeEdit({
  target: "bullet",
  target_id: openLine.id,
  field: "text",
  value: "A long line that reads like a product description.",
  why: "From the import.",
  question_id: 4242,
});
assert.equal(firstGo.waiting, undefined);

const better = await proposeEdit({
  target: "bullet",
  target_id: openLine.id,
  field: "text",
  value: "Designed and published it, and what it is for.",
  why: "Leads with the purpose and cuts the spec detail.",
});
assert.equal(better.waiting, undefined, "a better version of the same line was refused");
assert.equal(better.pending.value, "Designed and published it, and what it is for.");
ok("a better version of the open line replaces it rather than being handed back");

assert.equal(better.pending.question_id, 4242);
ok("and it answers the same question, which the new proposal did not have to name");

/* What the slot is actually for still holds. */
const elsewhere = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "Something unrelated",
  why: "A different question entirely.",
});
assert.ok(elsewhere.waiting, "a proposal about something else was allowed through");
assert.equal(elsewhere.pending.target_id, openLine.id);
ok("a proposal aimed anywhere else still waits its turn");

console.log("\nA line that is not on the profile yet");

/*
  The import leaves things out and then asks whether they were wanted. Until
  "add" existed there was nothing on the page to ask that over: set, delete
  and ask all name a row, and the line in question is the one that does not
  exist. The assistant read the sentence out in the conversation instead and
  the profile highlighted nothing.
*/
await clearEdit("assistant");
const host = await profile.addRole({
  company: "MuffinLabs",
  title: "Founder",
  location: null,
  start_date: "2026-01",
  end_date: null,
  summary: null,
});

const offered = await proposeEdit({
  target: "bullet",
  target_id: host.id,
  field: "text",
  action: "add",
  value: "Building systems that work in production.",
  why: "The import left this out as a tagline. Want it?",
});
assert.equal(offered.pending.action, "add");
ok("a line can be offered under a role rather than changed in place");

assert.equal(offered.pending.current, null);
ok("and it has no current value, because there is nothing there yet");

const before = (await profile.listBullets()).filter((one) => one.role_id === host.id).length;
await resolveEdit("use");
const after = (await profile.listBullets()).filter((one) => one.role_id === host.id);
assert.equal(after.length, before + 1);
assert.equal(after.at(-1)?.text, "Building systems that work in production.");
ok("keeping it creates the line under that role");

/* Emptying the box is how somebody says no to a line, so nothing is made. */
await proposeEdit({
  target: "bullet",
  target_id: host.id,
  field: "text",
  action: "add",
  value: "Another line nobody wants.",
  why: "Offered.",
});
await resolveEdit("use", "   ");
assert.equal(
  (await profile.listBullets()).filter((one) => one.role_id === host.id).length,
  after.length,
);
ok("and emptying the box adds nothing rather than an empty line");

await assert.rejects(
  proposeEdit({
    target: "role",
    target_id: host.id,
    field: "company",
    action: "add",
    value: "Something",
    why: "Not allowed.",
  }),
  /Only a bullet can be added/,
);
ok("only a bullet can be added this way, so the action cannot be misaimed");

console.log("\nThe answers a card offers, and the one it recommends");

/*
  The card used to work its buttons out from the action as it rendered, which
  is how a question that said "keep it as it is, trim it, or drop it?" came
  to sit above two buttons, neither of which dropped anything. So the answers
  belong to the proposal, and so does the recommendation.
*/
const aLine = (await profile.listBullets()).find((one) => one.role_id === host.id)!;

const aboutALine = await proposeEdit({
  target: "bullet",
  target_id: aLine.id,
  field: "text",
  action: "ask",
  value: "",
  why: "Mostly describes the architecture.",
  recommend: "drop",
});
assert.deepEqual(aboutALine.pending.answers, ["use", "leave", "drop"]);
assert.equal(aboutALine.pending.recommend, "drop");
ok("a card about a line that exists can drop it, and can recommend dropping it");
await clearEdit("assistant");

await assert.rejects(
  proposeEdit({
    target: "profile",
    field: "headline",
    value: "A headline.",
    why: "From the document.",
    recommend: "drop",
  }),
  /cannot offer "drop"/,
);
ok("a profile field cannot be dropped, so no card about one may recommend it");

const alsoOffered = await proposeEdit({
  target: "bullet",
  target_id: host.id,
  field: "text",
  action: "add",
  value: "A line the import left out.",
  why: "Reads as a pitch rather than work.",
});
assert.deepEqual(alsoOffered.pending.answers, ["use", "leave"]);
assert.equal(alsoOffered.pending.recommend, "leave");
ok("an offered line recommends leaving it out, which is what the import judged");
await clearEdit("assistant");

const suggested = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "ML engineer, the recommendation case",
  why: "From the document.",
});
assert.equal(suggested.pending.recommend, "use");
ok("and a suggestion recommends itself, so a card never highlights by accident");

await assert.rejects(resolveEdit("drop"), /does not offer "drop"/);
ok("an answer the card does not offer is refused rather than guessed at");
await resolveEdit("leave");

console.log("\nDropping the line from the card");

const doomed = (await profile.listBullets()).find((one) => one.role_id === host.id)!;
await proposeEdit({
  target: "bullet",
  target_id: doomed.id,
  field: "text",
  action: "ask",
  value: "",
  why: "Is this worth keeping?",
  recommend: "drop",
});
const dropped = await resolveEdit("drop");
assert.equal(dropped.removed, true);
assert.equal(
  (await profile.listBullets()).some((one) => one.id === doomed.id),
  false,
);
ok("choosing drop takes the line away, which no button on the card could do before");

console.log(`\n${passed} passed, 0 failed`);
