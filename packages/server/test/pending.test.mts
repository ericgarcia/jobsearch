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
import {
  clearEdit,
  pendingEdit,
  proposeEdit,
  resolveEdit,
  whatCanBeProposed,
} from "../src/pending.js";
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
  /Only a bullet or a skill can be added/,
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

console.log("\nThe skills list, which is a section and not a row");

/*
  The question that had nowhere to land. Three things are worth pinning
  down: that a set of names goes on one card, that keeping it adds rather
  than replaces, and that a name already on the list is not written twice.
*/

await profile.addSkill("Python");

await assert.rejects(
  proposeEdit({
    target: "skills",
    field: "names",
    value: "Claude Code",
    why: "Their lines show it.",
  }),
  /action "add"/,
);
ok("a skills card only ever adds, so it cannot be made to replace the list");

await assert.rejects(
  proposeEdit({
    target: "skills",
    field: "names",
    action: "add",
    value: " , ,",
    why: "Their lines show it.",
  }),
  /Name the skills/,
);
ok("and it has to name something");

const offeredSkills = await proposeEdit({
  target: "skills",
  field: "names",
  action: "add",
  value: "Claude Code, Playwright, Python",
  why: "Their lines use these and the list does not name them.",
});
assert.deepEqual(offeredSkills.pending.answers, ["use", "leave"]);
assert.equal(offeredSkills.pending.target_id, null);
ok("one card carries the whole set, with no row to hang on");

assert.equal(
  (await profile.listSkills()).some((one) => one.name === "Claude Code"),
  false,
);
ok("and proposing them stores none of them");

const added = await resolveEdit("use", "Claude Code, Playwright, Python");
assert.deepEqual(added.added, ["Claude Code", "Playwright"]);
ok("keeping it adds the new names and skips the one already there");

const names = (await profile.listSkills()).map((one) => one.name);
assert.equal(names.filter((one) => one === "Python").length, 1);
assert.ok(names.includes("Claude Code") && names.includes("Playwright"));
ok("so the list gains two and Python is not listed twice");

await proposeEdit({
  target: "skills",
  field: "names",
  action: "add",
  value: "Docker",
  why: "Their containers ran on something.",
  recommend: "leave",
});
const left = await resolveEdit("leave");
assert.equal(left.kept, false);
assert.equal(
  (await profile.listSkills()).some((one) => one.name === "Docker"),
  false,
);
ok("and leaving it adds nothing, as on every other card");

console.log("\nThe other half of the skills question");

/*
  "These are on your list and no line of yours shows them" is the reverse of
  "these are in your lines and not on your list", and the card could only do
  the second. So the assistant asked in the conversation, and the section it
  was asking about lit up in no way at all — the same gap the add card was
  built to close, left open on the other side.
*/

await profile.addSkill("SwiftUI");
await profile.addSkill("Redshift");

const about = await proposeEdit({
  target: "skills",
  field: "names",
  action: "ask",
  value: "SwiftUI, Redshift",
  why: "These are on your list but no line of yours shows them.",
  recommend: "leave",
});
assert.deepEqual(about.pending.answers, ["leave", "drop"]);
ok("a question about skills they have offers keeping them or dropping them, and nothing else");

const takenOff = await resolveEdit("drop");
assert.deepEqual(takenOff.dropped, ["SwiftUI", "Redshift"]);
assert.equal(
  (await profile.listSkills()).some((one) => one.name === "SwiftUI" || one.name === "Redshift"),
  false,
);
ok("and dropping takes off the ones it named");

await profile.addSkill("Matlab");
await proposeEdit({
  target: "skills",
  field: "names",
  action: "ask",
  value: "Matlab",
  why: "No line shows it.",
  recommend: "leave",
});
await resolveEdit("leave");
assert.equal(
  (await profile.listSkills()).some((one) => one.name === "Matlab"),
  true,
);
ok("while leaving it keeps the skill, as the button says");

await assert.rejects(
  proposeEdit({
    target: "skills",
    field: "names",
    action: "ask",
    value: "Fortran",
    why: "No line shows it.",
    recommend: "leave",
  }),
  /Not on their skills list/,
);
ok("and a question about a skill they do not have is refused, since it would mark nothing");

console.log("\nA row that is not there");

/*
  Ids outlive the rows they named. A question queued against a line that was
  deleted an hour later produced a card with no row to sit on and three
  buttons of which none could do anything — an update that wrote to a
  missing id, a drop that deleted nothing. So the card is refused when it is
  made, and the answer says so when the row goes in between.
*/

const doomedToo = await profile.addBullet(host.id, "A line about to be deleted.");
await profile.deleteBullet(doomedToo.id);

await assert.rejects(
  proposeEdit({
    target: "bullet",
    target_id: doomedToo.id,
    field: "text",
    action: "ask",
    value: "",
    why: "Is this right?",
    recommend: "leave",
  }),
  /not on their profile/,
);
ok("a card about a line that is gone is refused rather than made");

await assert.rejects(
  proposeEdit({
    target: "bullet",
    target_id: 9999,
    field: "text",
    action: "add",
    value: "Under a role that does not exist.",
    why: "From the document.",
    recommend: "leave",
  }),
  /not on their profile/,
);
ok("and so is a line offered under a role that is not there");

const vanishing = await profile.addBullet(host.id, "Here when the card was made.");
await proposeEdit({
  target: "bullet",
  target_id: vanishing.id,
  field: "text",
  value: "A better version of it.",
  why: "Tighter.",
});
await profile.deleteBullet(vanishing.id);
const nothing = await resolveEdit("use");
assert.equal(nothing.gone, true);
assert.equal(nothing.kept, false);
ok("and a row that goes between the question and the answer writes nothing, and says so");

console.log("\nA question about the work, which is not a field");

/*
  "Was the detection work yours alone, or did you work with a team?" is
  about a job, and a job's fields are its company, its title, its place and
  its dates. None of those is the work, so the card went on the title: the
  question appeared beside the words "Senior Machine Learning Engineer", in
  a box offering to correct them, above a Drop it that would have taken the
  whole job off the profile.
*/

const keeper = await profile.addRole({ company: "Keeper", title: "Senior ML Engineer" });

const pointing = await proposeEdit({
  target: "role",
  target_id: keeper.id,
  field: "work",
  action: "ask",
  value: "",
  why: "Was the detection work yours alone, or did you work with a team?",
  recommend: "leave",
});
assert.deepEqual(pointing.pending.answers, ["leave"]);
assert.equal(pointing.pending.current, null);
ok("a question about the work has one button and nothing to correct");

await assert.rejects(
  proposeEdit({
    target: "role",
    target_id: keeper.id,
    field: "work",
    value: "Something",
    why: "Trying to write it.",
  }),
  /stores nothing/,
);
ok('and "work" cannot be used to write, since no button could carry it out');

/*
  The pointer gets out of the way by itself. Its question is answered in the
  conversation, and what comes of that is a line proposed straight after —
  which the one slot would otherwise turn away.
*/
await proposeEdit({
  target: "role",
  target_id: keeper.id,
  field: "work",
  action: "ask",
  value: "",
  why: "Who else was on the team?",
  recommend: "leave",
});
const fromAnswer = await proposeEdit({
  target: "bullet",
  target_id: keeper.id,
  field: "text",
  action: "add",
  value: "Led the detection work with two other engineers.",
  why: "From what they just said.",
  recommend: "use",
});
assert.equal(fromAnswer.waiting, undefined);
assert.equal(fromAnswer.pending.action, "add");
ok("and the line that comes out of the answer takes the slot rather than being refused");
await clearEdit("assistant");

console.log("\nWhat the assistant is told it can propose");

/*
  The prompt used to carry this list by hand and say "it reaches four
  things". It was true when it was written; skills and education were added
  later, and the assistant believed the prompt over the tool and asked about
  skills in the conversation, where the page highlights nothing. So the
  sentence is built from the table that decides what a proposal may touch,
  and this checks the two cannot come apart.
*/

const told = whatCanBeProposed();
for (const target of ["profile", "role", "bullet", "fact", "education", "skills"]) {
  assert.ok(told.includes(`target "${target}"`), `the prompt does not mention ${target}`);
}
ok("every target that can be proposed is named in what the assistant is told");

for (const field of ["summary", "start_date", "names", "answer"]) {
  assert.ok(told.includes(field), `the prompt does not mention the ${field} field`);
}
ok("and so are the fields, so a target cannot be half described");

console.log("\nWhat a card's id names");

/*
  A bullet and a role may both be numbered 7; they are different tables and
  that is not a collision. What went wrong was a lookup in the wrong one:
  for an offered line, target_id is the ROLE it would join, and the check
  when the card was answered read it as a bullet id. Bullet 7 had been
  deleted, role 7 had not, and the card closed itself saying the line was no
  longer on the profile — a line that had never been on it, because offering
  it is the whole point.
*/

const host2 = await profile.addRole({ company: "Preact", title: "Founding ML Engineer" });
const sameNumber = await profile.addBullet(host2.id, "A line whose id will match a role's.");
/* Make a bullet and a role that share a number, then delete the bullet. */
await profile.deleteBullet(sameNumber.id);

const offeredLine = await proposeEdit({
  target: "bullet",
  target_id: host2.id,
  field: "text",
  action: "add",
  value: "Used Redis to group user actions into sessions.",
  why: "They described it just now.",
  recommend: "use",
});
assert.equal(offeredLine.pending.action, "add");

const put = await resolveEdit("use");
assert.equal(put.gone, undefined);
assert.equal(put.kept, true);
assert.equal(
  (await profile.listBullets()).some((one) => one.text.includes("group user actions")),
  true,
);
ok("an offered line is added under its role, whatever became of the bullet of that number");

console.log("\nTelling one card from the next");

const cardOne = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "One",
  why: "First.",
});
const cardTwo = await proposeEdit({
  target: "profile",
  field: "headline",
  value: "Two",
  why: "Second, in the same second.",
});
assert.notEqual(cardOne.pending.token, cardTwo.pending.token);
ok("two cards made in the same second are told apart, which `at` could not do");
await clearEdit("assistant");

console.log("\nPointing at a phrase");

/*
  A card highlights a whole field, which is right for a line of a resume and
  wrong for a four-paragraph summary: the question is about four words of it
  and the person is handed the lot to search. The quote is the assistant's
  own words marking the person's, so the thing to pin down is that it can
  only ever mark text that is really there, exactly once.
*/

await profile.updateProfile({
  summary: "I build systems. The work was pipelines, low-latency serving, and the monitoring. I build systems.",
});

const pointed = await proposeEdit({
  target: "profile",
  field: "summary",
  action: "ask",
  value: "",
  quote: "low-latency serving",
  why: "Which system was low-latency?",
  recommend: "leave",
});
assert.equal(pointed.pending.quote, "low-latency serving");
ok("a phrase that is in the stored text, once, is carried on the card");
await clearEdit("assistant");

await assert.rejects(
  proposeEdit({
    target: "profile",
    field: "summary",
    action: "ask",
    value: "",
    quote: "kubernetes at scale",
    why: "Where was this?",
    recommend: "leave",
  }),
  /not in the stored text/,
);
ok("one that is not there is refused, so a card cannot mark words they never wrote");

await assert.rejects(
  proposeEdit({
    target: "profile",
    field: "summary",
    action: "ask",
    value: "",
    quote: "I build systems.",
    why: "Which systems?",
    recommend: "leave",
  }),
  /appears 2 times/,
);
ok("and one that is there twice is refused, since a mark would point at the wrong one");

const whole = await proposeEdit({
  target: "profile",
  field: "summary",
  action: "ask",
  value: "",
  why: "Is this still right?",
  recommend: "leave",
});
assert.equal(whole.pending.quote, null);
ok("a question about the whole field carries no quote, as before");
await clearEdit("assistant");

console.log("\nA question about more than one field");

/*
  A card takes one field, so the question "were you doing NuMundo alongside
  Preact?" — which is about two dates — was put on the job title, and the
  person read a question about an overlap beside a box containing "CTO".
  What matters is that the card carries every field in question with what is
  stored in each, and says which one the answer changes.
*/

const overlap = await profile.addRole({
  company: "NuMundo",
  title: "Chief Technology Officer",
  start_date: "2015-03",
  end_date: "2015-12",
});

const both = await proposeEdit({
  target: "role",
  target_id: overlap.id,
  field: "end_date",
  action: "ask",
  value: "",
  fields: ["start_date", "end_date"],
  why: "These dates fall inside your time at Preact.",
  recommend: "leave",
});
assert.deepEqual(
  both.pending.fields.map((one) => [one.field, one.value, one.edits]),
  [
    ["end_date", "2015-12", true],
    ["start_date", "2015-03", false],
  ],
);
ok("both dates travel with the card, with what is stored in each");

assert.equal(both.pending.fields.filter((one) => one.edits).length, 1);
ok("and exactly one of them is marked as the one the answer changes");
await clearEdit("assistant");

await assert.rejects(
  proposeEdit({
    target: "role",
    target_id: overlap.id,
    field: "end_date",
    action: "ask",
    value: "",
    fields: ["manager"],
    why: "Who did you report to?",
    recommend: "leave",
  }),
  /not one of the fields of a role/,
);
ok("a field a role does not have is refused, as the single field already was");

const alone = await proposeEdit({
  target: "role",
  target_id: overlap.id,
  field: "title",
  value: "CTO",
  why: "Shorter.",
});
assert.deepEqual(alone.pending.fields, []);
ok("and a question about one field carries no list, as before");
await resolveEdit("leave");

console.log(`\n${passed} passed, 0 failed`);
