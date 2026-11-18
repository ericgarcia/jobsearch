/*
  The fact store, and deciding the voluntary section one question at a time.

  Two things here are worth more than the rest of the file. A refusal has to
  be distinguishable from an absence, or the app asks a settled question once
  per employer for ever. And a private answer must not be storable in the
  open table, which is checked here by trying it.

  The database is a scratch one: JOBSEARCH_DATA_DIR is set by the test
  script, so nothing here touches the real list.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/facts.test.mts
*/

import assert from "node:assert/strict";
import { all, get, migrate, run } from "../src/db/client.js";
import {
  declineFact,
  forgetFact,
  getFact,
  listFacts,
  recordFact,
  reopenFact,
  seedQuestions,
  setFact,
  setFactShare,
  shareableFacts,
} from "../src/apply/facts.js";
import {
  coverage,
  declineSelfIdentification,
  declineStandingAnswer,
  includedKeys,
  listStandingAnswers,
  readSelfIdentification,
  setSelfIdentification,
  setStandingAnswer,
  setVoluntaryChoices,
  voluntarySection,
} from "../src/apply/answers.js";
import type { ApplicationForm } from "../src/apply/form.js";
import { byWords } from "../src/apply/form.js";
import { setVoluntaryDefault, voluntaryDefault } from "../src/settings.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

await run(
  `INSERT INTO jobs (id, source, source_job_id, company, title, url)
        VALUES (1, 'lever', 'x:1', 'Acme', 'Engineer', 'https://example.com/jobs/1')`,
);

console.log("\n1. A question the app has never heard of is storable");

/*
  The reason this store exists. The old one was keyed on a list of eight
  topics, so a clearance question had nowhere to go: it was answered once for
  one employer, written to that application's record, and asked again by the
  next form that wanted it.
*/
await setFact({
  slug: "security_clearance",
  question: "Do you hold a security clearance?",
  answer: "Yes — Secret, active since 2024",
  source: "application:1",
});

const clearance = await getFact("security_clearance");
assert.equal(clearance?.answer, "Yes — Secret, active since 2024");
assert.equal(clearance?.state, "answered");
assert.equal(clearance?.sensitivity, "open");
assert.equal(clearance?.share, "always");
assert.equal(clearance?.source, "application:1");
ok("it is stored beside the seeded ones, with where it came from");

assert.ok(seedQuestions().some((seed) => seed.slug === "work_authorization"));
assert.ok(!seedQuestions().some((seed) => seed.slug === "security_clearance"));
ok("the eight seeds are suggestions, not the schema");

console.log("\n2. The old standing-answer shape still works over the new store");

/*
  Every caller — the person's page, the form filler, the agent tools — speaks
  in topics, and a rename nobody asked for is a change with no benefit. So
  the shape stayed and the store underneath it changed.
*/
await setStandingAnswer("work_authorization", "Yes — US citizen");
const standing = await listStandingAnswers();
assert.equal(standing.find((row) => row.topic === "work_authorization")?.answer, "Yes — US citizen");
assert.match(
  standing.find((row) => row.topic === "work_authorization")?.question ?? "",
  /legally authorised/i,
);
ok("a standing answer round-trips, with the app's own wording for the question");

await setStandingAnswer("work_authorization", "");
assert.equal(await getFact("work_authorization"), null);
ok("an empty answer removes the fact rather than storing a blank");

console.log("\n3. A refusal is not an absence");

/*
  The distinction the whole feature rests on. "Nothing stored" is a question
  to put to someone. "They said no" is a question already answered, and
  asking it again on the next application is the app overruling them.
*/
await declineStandingAnswer("salary");
const refused = await getFact("salary");
assert.equal(refused?.state, "declined");
assert.equal(refused?.share, "never");
assert.equal(refused?.answer, null);
ok("it is written down, with no answer attached");

assert.equal((await shareableFacts()).some((fact) => fact.slug === "salary"), false);
ok("and it is not among the facts a form may be filled from");

const form: ApplicationForm = {
  ats: "lever",
  url: "https://example.com/apply",
  fields: [
    { label: "What are your salary expectations?", type: "text", required: true, kind: byWords("What are your salary expectations?") },
    { label: "What is your notice period?", type: "text", required: true, kind: byWords("What is your notice period?") },
  ],
};

const seen = await coverage(form);
const salary = seen.fields.find((field) => /salary/i.test(field.label))!;
const notice = seen.fields.find((field) => /notice/i.test(field.label))!;
assert.match(salary.missing ?? "", /asked not to be asked/i);
assert.match(notice.missing ?? "", /No answer stored/i);
ok("a declined question reads differently from one that was never answered");

console.log("\n4. And a refusal can be withdrawn");

await reopenFact("salary");
const reopened = await getFact("salary");
assert.equal(reopened?.state, "asked");
assert.equal(reopened?.share, "always");
ok("the question is open again, and still unanswered");

console.log("\n5. On file is not the same as offered");

await setFact({ slug: "notice_period", answer: "Three months" });
await setFactShare("notice_period", "never");
assert.equal((await getFact("notice_period"))?.answer, "Three months");
assert.equal((await shareableFacts()).some((fact) => fact.slug === "notice_period"), false);
ok("an answer kept for their own records is not an answer to send");

assert.equal(
  (await listStandingAnswers()).some((row) => row.topic === "notice_period"),
  false,
  "a withheld answer was offered to the form filler",
);
ok("so the filler is not given it either");

console.log("\n6. A private answer cannot be stored in the open table");

/*
  Checked by trying it, because this is the invariant the separation rests
  on. The promise is that a self-identification value lives in exactly one
  table; a bug in facts.ts should fail here rather than quietly make a second
  copy.
*/
await assert.rejects(
  () => setFact({ slug: "disability", answer: "no", sensitivity: "private" }),
  /not stored in facts/i,
);
ok("the writer refuses it, and says where it belongs");

await assert.rejects(
  () =>
    run(
      `INSERT INTO facts (slug, question, answer, state, sensitivity, share)
            VALUES ('gender', 'Gender', 'woman', 'answered', 'private', 'ask')`,
    ),
  /CHECK|constraint/i,
);
ok("and so does the table, for anything that gets past the writer");

console.log("\n7. A voluntary detail gets a row for its state and never its value");

await setSelfIdentification("pronouns", "they_them");
const pronouns = await getFact("pronouns");
assert.equal(pronouns?.sensitivity, "private");
assert.equal(pronouns?.state, "answered");
assert.equal(pronouns?.answer, null);
assert.equal(pronouns?.share, "ask");
ok("answered, shareable only by asking, and empty where the answer would be");

assert.equal((await readSelfIdentification()).pronouns, "they_them");
ok("the value itself is in the one table that holds values");

await setSelfIdentification("pronouns", "");
assert.equal((await getFact("pronouns"))?.state, "asked");
ok("clearing the value leaves the app with nothing, which is not a refusal");

console.log("\n8. Declining a voluntary detail takes the value with it");

/*
  A row saying "declined" while still holding a value says two things, and
  the one a form would act on is the value. So the value goes.

  This is also not the `decline` token: that is "Prefer not to disclose",
  an answer the form itself offers and which gets ticked. This is "stop
  asking me", and it leaves the field blank.
*/
await setSelfIdentification("disability", "no");
assert.equal((await readSelfIdentification()).disability, "no");
await declineSelfIdentification("disability");

assert.equal((await readSelfIdentification()).disability, undefined);
assert.equal((await getFact("disability"))?.state, "declined");
ok("the stored answer is gone and the refusal is on record");

await setSelfIdentification("disability", "");
assert.equal((await getFact("disability"))?.state, "declined");
ok("and a later empty write does not quietly withdraw it");

console.log("\n9. Which voluntary questions go on this application, one by one");

/*
  "Fill in the voluntary part" is not one decision. Someone may be glad to
  give an employer their pronouns and have no intention of giving a
  disability status, and a single yes would answer for both.
*/
await setSelfIdentification("pronouns", "they_them");
await setSelfIdentification("gender", "woman");
await setSelfIdentification("veteran", "no");

assert.deepEqual([...(await includedKeys(1))], []);
ok("nothing is included until they say so, however much is stored");

await setVoluntaryChoices(1, ["pronouns"], ["gender"]);
const included = await includedKeys(1);
assert.deepEqual([...included], ["pronouns"]);
ok("a yes to one is not a yes to the next");

assert.equal(included.has("veteran"), false);
ok("and a question they were not asked about stays out");

console.log("\n10. A refusal outranks a yes, and a standing no outranks everything");

await declineSelfIdentification("veteran");
await setVoluntaryChoices(1, ["pronouns", "veteran"]);
assert.deepEqual([...(await includedKeys(1))], ["pronouns"]);
ok("a declined question is not filled in even when it is named");

assert.equal(await voluntaryDefault(), "ask");
await setVoluntaryDefault("never");
assert.deepEqual([...(await includedKeys(1))], []);
ok("someone who has said they never disclose is not asked and nothing is filled");

await setVoluntaryDefault("ask");

console.log("\n11. What the section looks like before it is decided");

const survey: ApplicationForm = {
  ats: "lever",
  url: "https://example.com/apply",
  fields: [
    { label: "What best describes your gender?", type: "select", required: false, kind: "eeo", section: "Demographic Survey" },
    { label: "What are your pronouns?", type: "select", required: false, kind: "eeo", section: "Demographic Survey" },
    { label: "Are you a protected veteran?", type: "select", required: false, kind: "eeo", section: "Demographic Survey" },
    { label: "What best describes your gender?", type: "select", required: false, kind: "eeo", section: "EEO" },
    /*
      The same detail in another employer's words. Spotify's page carries
      both of these, and listing them separately would ask someone to decide
      twice about one thing — and then disagree with itself if they answered
      differently.
    */
    { label: "What gender do you identify with?", type: "select", required: false, kind: "eeo", section: "EEO" },
  ],
};

/*
  A second application, because the first has had every question decided
  above and the interesting state is the one before anyone has answered.
*/
await run(
  `INSERT INTO jobs (id, source, source_job_id, company, title, url)
        VALUES (2, 'lever', 'x:2', 'Other', 'Engineer', 'https://example.com/jobs/2')`,
);
await setVoluntaryChoices(2, ["pronouns"]);

const section = await voluntarySection(survey, 2);
assert.equal(section.questions.length, 3, "one detail was reported as more than one question");
ok("a detail asked twice, in two wordings, is one question to decide");

const byKey = new Map(section.questions.map((question) => [question.key, question]));
assert.equal(byKey.get("pronouns")?.include, true);
assert.equal(byKey.get("gender")?.include, null);
assert.equal(byKey.get("veteran")?.declined, true);
assert.equal(byKey.get("veteran")?.include, false);
ok("each question carries its own decision, and a refusal counts as decided");

assert.equal(section.undecided, 1);
ok("so only the genuinely open ones are left to confirm");

assert.equal(byKey.get("veteran")?.stored, false);
ok("a declined question is not reported as answerable, whatever is on file");

await setVoluntaryDefault("never");
assert.equal((await voluntarySection(survey, 2)).undecided, 0);
await setVoluntaryDefault("ask");
ok("and a standing no leaves nothing to ask about");

console.log("\n12. Forgetting a fact forgets both halves of it");

await setSelfIdentification("gender", "woman");
await forgetFact("gender");
assert.equal(await getFact("gender"), null);
assert.equal((await readSelfIdentification()).gender, undefined);
ok("the row and the value go together, so neither outlives the other");

console.log("\n13. The old answers are carried across, once");

/*
  The backfill runs on migrate() and is guarded by a marker row rather than
  by the table being empty — otherwise deleting a fact would resurrect it on
  the next start. Tested by putting the marker back where it was.
*/
await run(
  `INSERT INTO standing_answers (topic, question, answer)
        VALUES ('relocation', 'Are you willing to relocate?', 'Yes, for the right role')`,
);
await run(`DELETE FROM settings WHERE key = 'facts_from_topics'`);
await migrate();

assert.equal((await getFact("relocation"))?.answer, "Yes, for the right role");
assert.equal((await getFact("relocation"))?.source, "standing_answers");
ok("a stored topic becomes a fact, marked with where it came from");

await forgetFact("relocation");
await migrate();
assert.equal(await getFact("relocation"), null);
ok("and deleting one does not bring it back on the next start");

console.log("\n14. Nothing in the fact store carries a voluntary answer");

/*
  The last line of defence, as a query rather than an argument: whatever the
  code above did, no private value is in this table.
*/
const leaked = await all<{ slug: string }>(
  `SELECT slug FROM facts WHERE sensitivity = 'private' AND answer IS NOT NULL`,
);
assert.deepEqual(leaked, []);
ok("checked directly, and there are none");

const marker = await get<{ value: string }>(
  `SELECT value FROM settings WHERE key = 'facts_from_topics'`,
);
assert.ok(marker, "the backfill marker was not written");
ok("and the migration left its marker behind");

console.log(`\n${passed} passed, 0 failed`);
