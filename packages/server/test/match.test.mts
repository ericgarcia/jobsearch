/*
  Matching a form's question to an answer already on file.

  The point of the fact store, and the part that can do harm: a wrong match
  is not a blank field, it is an answer sent to an employer to a question
  they did not ask. So the tests here are mostly about refusing — an invented
  slug, a stale one, a question that is the employer's own.

  The model call itself is not exercised; these run without a credential, so
  what is checked is the cache, the fingerprint, the three expiries, and what
  happens when the call cannot be made at all.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/match.test.mts
*/

import assert from "node:assert/strict";
import { all, migrate, run } from "../src/db/client.js";
import {
  cachedMatches,
  fingerprintOf,
  forgetMatches,
  matchByWords,
  matchFacts,
  MATCH_MODEL,
  rememberMatch,
} from "../src/apply/match.js";
import { candidateFacts, declineFact, forgetFact, setFact, setFactShare } from "../src/apply/facts.js";
import { coverage } from "../src/apply/answers.js";
import type { ApplicationForm } from "../src/apply/form.js";
import type { Asked } from "../src/apply/classify.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const slugsNow = async () => (await candidateFacts()).map((fact) => fact.slug);

console.log("\n1. The patterns are the fallback, and no longer the first pass");

await setFact({ slug: "notice_period", answer: "Three months" });
const have = new Set(await slugsNow());

assert.equal(matchByWords({ label: "What is your notice period?" }, have), "notice_period");
ok("a pattern over one of the eight still reaches it when there is nothing better");

assert.equal(matchByWords({ label: "What notice do you have to give?" }, new Set()), null);
ok("and matches nothing when that answer is not on file");

assert.equal(matchByWords({ label: "Do you hold a security clearance?" }, have), null);
ok("a question outside the eight is beyond the patterns, which is why reading exists");

console.log("\n2. What a cached match is keyed on");

const asked: Asked = { label: "Do you hold an active security clearance?" };
const one = fingerprintOf(asked, ["notice_period", "security_clearance"]);

assert.equal(one, fingerprintOf(asked, ["security_clearance", "notice_period"]));
ok("the candidates are a set, so two employers listing them differently key alike");

assert.notEqual(one, fingerprintOf(asked, ["notice_period"]));
ok("but adding a fact is a different key, so a new answer is not invisible to the question");

assert.notEqual(
  one,
  fingerprintOf({ ...asked, section: "Security" }, ["notice_period", "security_clearance"]),
);
ok("and the heading above the question counts, as it does everywhere else");

console.log("\n3. A remembered no is remembered");

/*
  The common answer, and the one worth not paying for twice. "Why do you want
  to work here?" is on every form and matches nothing, and asking about it
  once per application would be a call per application for the same no.
*/
const own: Asked = { label: "Why do you want to work here?" };
const slugs = ["notice_period"];
await rememberMatch(own, slugs, null);
const remembered = await cachedMatches([fingerprintOf(own, slugs)]);
assert.equal(remembered.has(fingerprintOf(own, slugs)), true);
assert.equal(remembered.get(fingerprintOf(own, slugs)), null);
ok("the row is there and the slug is null, which are different things");

await rememberMatch(asked, slugs, "notice_period");
assert.equal(
  (await cachedMatches([fingerprintOf(asked, slugs)])).get(fingerprintOf(asked, slugs)),
  "notice_period",
);
ok("and a match comes back as the slug it was stored under");

console.log("\n4. A judgement cached for ever is a judgement nobody can correct");

const key = fingerprintOf(asked, slugs);

await run(`UPDATE fact_matches SET at = datetime('now', '-200 days') WHERE fingerprint = ?`, key);
assert.equal((await cachedMatches([key])).size, 0);
ok("it expires by age");

await run(`UPDATE fact_matches SET at = datetime('now'), model = 'some-older-model' WHERE fingerprint = ?`, key);
assert.equal((await cachedMatches([key])).size, 0);
ok("it expires when the model changes");

await run(`UPDATE fact_matches SET model = ?, rules = 'rules-from-before' WHERE fingerprint = ?`, MATCH_MODEL, key);
assert.equal((await cachedMatches([key])).size, 0);
ok("and it expires when the rules it was made under change, so editing the prompt is the fix");

await forgetMatches();
assert.equal(
  (await all<{ fingerprint: string }>(`SELECT fingerprint FROM fact_matches WHERE at <= datetime('now', '-90 days')`)).length,
  0,
);
ok("and what no read will trust again is thrown away");

console.log("\n5. Without a credential it falls back rather than failing");
/*
  And the fallback is the patterns, which is also the one place they run.
  They matched "Visa or permit number" to a sponsorship answer when they ran
  first, which is why they do not any more.
*/

await run(`DELETE FROM fact_matches`);
const fallen = await matchFacts([
  { label: "What is your notice period?" },
  { label: "Do you hold an active security clearance?" },
]);
assert.equal(fallen.get("What is your notice period?"), "notice_period");
assert.equal(fallen.has("Do you hold an active security clearance?"), false);
ok("the patterns answer what they can and the rest is left to the person");

assert.deepEqual(await all<{ fingerprint: string }>(`SELECT fingerprint FROM fact_matches`), []);
ok("and nothing is written down, because nothing was judged");

console.log("\n6. A match to a fact that is no longer there is not a match");

/*
  Written deliberately as a row that is current by every other measure — the
  right model, the right rules, today's date, the candidate list as it stands
  — and names a fact that has gone. Deleting a fact changes the fingerprint,
  so this should be unreachable; it is checked because "should be unreachable"
  is how a blank gets typed into a field the person expected their own words
  in.
*/
await rememberMatch(asked, await slugsNow(), "security_clearance");
const stale = await matchFacts([asked]);
assert.equal(stale.has(asked.label), false);
ok("the slug is checked against what is on file now, not when the row was written");

console.log("\n7. A question outside the eight topics can finally be answered");

/*
  The whole point, end to end. The question is the employer's own as far as
  the classifier is concerned, and before this it was answered once, for one
  company, and thrown away. The cache row stands in for the model call.
*/
await setFact({
  slug: "security_clearance",
  question: "Do you hold a security clearance?",
  answer: "Yes — Secret, active since 2024",
});

const form: ApplicationForm = {
  ats: "greenhouse",
  url: "https://example.com/apply",
  fields: [
    {
      label: "Do you hold an active security clearance?",
      type: "text",
      required: true,
      kind: "custom",
    },
    { label: "Why do you want to work here?", type: "textarea", required: true, kind: "custom" },
  ],
};

await rememberMatch({ label: form.fields[0]!.label }, await slugsNow(), "security_clearance");
await rememberMatch({ label: form.fields[1]!.label }, await slugsNow(), null);

const seen = await coverage(form);
const clearance = seen.fields.find((field) => /clearance/i.test(field.label))!;
const motivation = seen.fields.find((field) => /want to work/i.test(field.label))!;

assert.equal(clearance.from, "standing");
assert.equal(clearance.missing, undefined);
ok("the stored answer is found, though no topic in the code names it");

assert.equal(motivation.from, null);
assert.match(motivation.missing ?? "", /written for this application/i);
ok("and the employer's own question is still the person's to answer");

assert.equal(seen.needsYou.some((field) => /clearance/i.test(field.label)), false);
ok("so it is no longer on the list of things left to do");

console.log("\n8. A refusal is reported as one, even here");

await declineFact({ slug: "salary_history", question: "What have you been paid before?" });
const payForm: ApplicationForm = {
  ats: "greenhouse",
  url: "https://example.com/apply",
  fields: [
    { label: "What was your most recent salary?", type: "text", required: true, kind: "custom" },
  ],
};
await rememberMatch({ label: payForm.fields[0]!.label }, await slugsNow(), "salary_history");

const payCoverage = await coverage(payForm);
assert.match(payCoverage.fields[0]!.missing ?? "", /asked not to be asked/i);
assert.equal(payCoverage.fields[0]!.from, null);
ok("a question matched to something they refused is left blank and says why");

assert.equal(payCoverage.needsYou.length, 0);
ok("and it is not put back on their list as a thing to do");

console.log("\n9. On file is still not the same as offered");

await setFact({ slug: "visa_number", question: "What is your visa number?", answer: "X-1234" });
await setFactShare("visa_number", "never");

const visaForm: ApplicationForm = {
  ats: "greenhouse",
  url: "https://example.com/apply",
  fields: [{ label: "Visa or permit number", type: "text", required: false, kind: "custom" }],
};
await rememberMatch({ label: visaForm.fields[0]!.label }, await slugsNow(), "visa_number");

const visaCoverage = await coverage(visaForm);
assert.equal(visaCoverage.fields[0]!.from, null);
assert.match(visaCoverage.fields[0]!.missing ?? "", /kept it off forms/i);
ok("an answer kept back is reported as kept back, not as missing");

console.log(`\n${passed} passed, 0 failed`);
