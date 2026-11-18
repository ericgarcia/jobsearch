/*
  Keeping an answer written for one employer, or not.

  The loop closes here: a question the store could not answer, answered by the
  person, offered back as something to keep. The judgement itself is a model
  call and is not exercised here — these run without a credential. What is
  checked is everything around it, which is where the damage would be: a name
  that collides with a voluntary detail, a refusal reopened by a suggestion,
  and the rule that nothing is stored without being asked.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/keep.test.mts
*/

import assert from "node:assert/strict";
import { migrate, run } from "../src/db/client.js";
import { keepable, vet } from "../src/apply/keep.js";
import {
  declineFact,
  getFact,
  listFacts,
  recordFact,
  setFact,
} from "../src/apply/facts.js";
import { declineStandingAnswer, setSelfIdentification } from "../src/apply/answers.js";
import { listAnswers, recordAnswers } from "../src/apply/record.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

await run(
  `INSERT INTO jobs (id, source, source_job_id, company, title, url)
        VALUES (1, 'greenhouse', 'x:1', 'Acme', 'Engineer', 'https://example.com/jobs/1')`,
);

console.log("\n1. A name has to be usable as a name");

assert.equal(vet("security_clearance", "Do you hold a security clearance?", null)?.slug, "security_clearance");
ok("a plain snake_case name is accepted");

for (const bad of ["Security Clearance", "security clearance", "9lives", "", "a", "x".repeat(60)]) {
  assert.equal(vet(bad, "A question?", null), null, `"${bad}" was accepted`);
}
ok("capitals, spaces, a leading digit, nothing and anything absurdly long are not");

assert.equal(vet("security_clearance", "   ", null), null);
ok("and a name with no question attached is refused, since nothing could match it later");

console.log("\n2. A voluntary detail's name is refused outright");

/*
  The check that matters most in this file. An open fact called "gender"
  would sit beside the private one of that name, be matched to a demographic
  question, and then be filled by the standing-answer path — which fills
  without asking anybody. One slug, two meanings, is the single way to get
  around the separation in facts.ts.
*/
for (const key of ["gender", "race", "veteran", "disability", "pronouns", "transgender", "sexual_orientation", "age", "location"]) {
  assert.equal(vet(key, "Something that looks innocent?", null), null, `${key} was accepted`);
}
ok("every voluntary key is rejected, whatever the question looks like");

console.log("\n3. A refusal is not reopened by a suggestion");

await declineStandingAnswer("salary", "What are you looking for in pay?");
assert.equal(vet("salary", "What are you paid now?", await getFact("salary")), null);
ok("a question they refused is not offered back as a thing to store");

await setSelfIdentification("pronouns", "they_them");
assert.equal(vet("pronouns", "What are your pronouns?", await getFact("pronouns")), null);
ok("and neither is anything already held as a private detail");

console.log("\n4. An existing answer keeps its own wording");

await setFact({
  slug: "highest_degree",
  question: "What is your highest degree?",
  answer: "BSc Computer Science, 2016",
});

const known = vet("highest_degree", "What level of education did you complete?", await getFact("highest_degree"));
assert.equal(known?.question, "What is your highest degree?");
assert.equal(known?.known, true);
ok("the question they have is kept, not the one the form happened to use");

/*
  Because that wording is what later forms are matched against — renaming it
  on their behalf would quietly change which questions find this answer.
*/
const fresh = vet("years_rust", "How many years have you written Rust?", null);
assert.equal(fresh?.question, "How many years have you written Rust?");
assert.equal(fresh?.known, false);
ok("a new one takes the proposed wording, and says it is new");

console.log("\n5. An answer in the asked state is a question, not an answer");

await recordFact({
  slug: "driving_licence",
  question: "Do you hold a driving licence?",
  sensitivity: "open",
  state: "asked",
});
assert.equal(vet("driving_licence", "Do you have a driver's license?", await getFact("driving_licence"))?.known, false);
ok("so it is offered as something to store rather than as something to update");

console.log("\n6. Nothing is kept without being asked");

/*
  The offer is an offer. An app that quietly kept every answer someone gave
  an employer would be assembling a profile of them out of things they said
  to somebody else, and it would do it from the one place where a mistake is
  already on a form.
*/
const before = (await listFacts()).length;
await recordAnswers(1, [
  { label: "Do you hold an active security clearance?", kind: "custom", value: "No" },
]);
assert.equal((await listFacts()).length, before);
ok("recording an answer stores nothing in the fact store on its own");

assert.equal((await listAnswers(1)).length, 1);
ok("it is written to this application's record, which is what it is for");

console.log("\n7. With no credential there is no judgement, and no guess");

assert.equal(await keepable("Do you hold an active security clearance?", "No"), null);
ok("it declines to decide rather than falling back to a pattern");

assert.equal(await keepable("", "No"), null);
assert.equal(await keepable("A question?", ""), null);
ok("and an empty question or answer is never judged at all");

console.log(`\n${passed} passed, 0 failed`);
