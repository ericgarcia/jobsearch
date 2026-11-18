/*
  Standing answers, self-identification, and what a form still needs.

  The database is a scratch one: JOBSEARCH_DATA_DIR is set by the test
  script, so nothing here touches the real list.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/answers.test.mts
*/

import assert from "node:assert/strict";
import { migrate, run } from "../src/db/client.js";
import {
  coverage,
  listStandingAnswers,
  readSelfIdentification,
  selfIdentificationKeysSet,
  selfIdKeyOf,
  setSelfIdentification,
  setStandingAnswer,
  topicOf,
} from "../src/apply/answers.js";
import type { ApplicationForm } from "../src/apply/form.js";
import { classify } from "../src/apply/form.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const field = (label: string, required = true) => ({
  label,
  type: "text" as const,
  required,
  kind: classify(label),
});

console.log("\n1. Two questions with the same words and opposite meanings");

/*
  Nearly every sponsorship question mentions authorization — "will you
  require sponsorship to retain or extend your work authorization" — so a
  matcher that checks authorization first answers the wrong one. Getting
  this backwards would tell an employer the opposite of the truth about
  someone's right to work.
*/
assert.equal(
  topicOf("Will you now or in the future require company sponsorship to retain or extend your work authorization?"),
  "sponsorship",
);
assert.equal(
  topicOf("Are you legally authorized to work in the country where the job is located?"),
  "work_authorization",
);
ok("sponsorship and authorisation are told apart");

for (const [label, topic] of [
  ["Are you willing to relocate for this role?", "relocation"],
  ["Are you open to working in person 3 times a week?", "onsite"],
  ["What is your notice period?", "notice_period"],
  ["What are your salary expectations?", "salary"],
  ["When could you start?", "start_date"],
  ["What is your favourite editor?", "other"],
] as const) {
  assert.equal(topicOf(label), topic, label);
}
ok("the rest of the topics land where they should");

console.log("\n2. Standing answers are stored as written");

await setStandingAnswer("work_authorization", "Yes — US citizen");
await setStandingAnswer("sponsorship", "No, I don't need sponsorship");
const stored = await listStandingAnswers();
assert.equal(stored.find((row) => row.topic === "sponsorship")?.answer, "No, I don't need sponsorship");
ok("kept verbatim, with the question they answer");

await setStandingAnswer("sponsorship", "");
assert.equal((await listStandingAnswers()).some((row) => row.topic === "sponsorship"), false);
ok("an empty answer removes it rather than storing nothing");

console.log("\n3. Self-identification is recognised, stored, and withheld");

for (const [label, key] of [
  ["What best describes your gender?", "gender"],
  ["What is your race/ethnicity?", "race"],
  ["Are you a veteran/have you served in the military?", "veteran"],
  ["Voluntary Self-Identification of Disability", "disability"],
  ["Pronouns", "pronouns"],
] as const) {
  assert.equal(selfIdKeyOf(label), key, label);
}
ok("each self-identification question is recognised");

await setSelfIdentification("gender", "Prefer not to disclose");
assert.deepEqual(await selfIdentificationKeysSet(), ["gender"]);
assert.equal((await readSelfIdentification()).gender, "Prefer not to disclose");
ok("stored, and reported as a key with no value attached");

console.log("\n4. What a form still needs");

const form: ApplicationForm = {
  ats: "greenhouse",
  url: "https://example.com/apply",
  fields: [
    field("First Name"),
    field("Email"),
    field("Resume/CV"),
    field("Are you legally authorized to work in the country where the job is located?"),
    field("Will you now or in the future require sponsorship?"),
    field("What best describes your gender?", false),
    field("Why do you want to work here?"),
  ],
};

/*
  An empty profile is a real state — it is where everybody starts — and it
  cannot answer a name or an email. Checked before the profile is filled in,
  because "we have this already" is the claim worth being wrong about.
*/
const blank = await coverage(form);
assert.equal(blank.fields.find((row) => /First Name/.test(row.label))?.from, null);
assert.match(blank.fields.find((row) => /First Name/.test(row.label))?.missing ?? "", /profile/i);
ok("with nothing in the profile, identity fields are outstanding and say why");

await run(
  `INSERT INTO profile (id, name, email) VALUES (1, 'A Person', 'a@example.com')
   ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email`,
);

const seen = await coverage(form);
const by = (match: RegExp) => seen.fields.find((row) => match.test(row.label))!;

assert.equal(by(/legally authorized/).from, "standing", "the stored answer was not used");
assert.equal(by(/sponsorship/).from, null, "an answer that was removed should not be claimed");
assert.equal(by(/Resume/).from, "documents");
assert.equal(by(/gender/).from, "self_identification");
assert.equal(by(/Why do you want/).from, null);
ok("each field is traced to where its answer comes from");

assert.deepEqual(
  seen.needsYou.map((row) => row.label),
  ["Will you now or in the future require sponsorship?", "Why do you want to work here?"],
);
ok("only the things a person must settle are listed as outstanding");

/*
  Leaving self-identification blank is a complete answer. Listing it as
  outstanding would be the app asking someone to disclose a disability.
*/
assert.equal(seen.needsYou.some((row) => row.kind === "eeo"), false);
ok("self-identification is never listed as something left to do");

console.log(`\n${passed} passed, 0 failed`);
