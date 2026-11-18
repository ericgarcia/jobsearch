/*
  The form readers, against saved copies of three real postings.

  Fixtures rather than the network, for two reasons. A test that fetches is a
  test that fails when a company closes a role, which says nothing about this
  code. And a board changing its markup is exactly what these tests exist to
  catch: a parser that silently returns an empty form would let the rest of
  the application machinery believe a job asks for nothing.

  The fixtures were taken on 2026-11-17 and say where from.

  Run: npx tsx test/applyform.test.mts
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { byWords, describe as describeForm, isVoluntarySection } from "../src/apply/form.js";
import { parseAshby, parseGreenhouse, parseLever } from "../src/apply/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");

let passed = 0;
function ok(what: string) {
  passed += 1;
  console.log(`  ok   ${what}`);
}

const labels = (form: { fields: { label: string }[] }) => form.fields.map((f) => f.label);
const kindOf = (form: { fields: { label: string; kind: string }[] }, match: RegExp) =>
  form.fields.find((f) => match.test(f.label))?.kind;

console.log("\n1. greenhouse, where the form is JSON inside the page");

const greenhouse = parseGreenhouse(
  fixture("greenhouse-scaleai.html"),
  "https://job-boards.greenhouse.io/scaleai/jobs/4658162005",
);

assert.ok(greenhouse.fields.length >= 10, `only ${greenhouse.fields.length} fields`);
ok(`read ${greenhouse.fields.length} fields`);

for (const wanted of ["First Name", "Last Name", "Email", "Resume/CV"]) {
  assert.ok(labels(greenhouse).includes(wanted), `missing ${wanted}`);
}
ok("the fields a person would expect are all there");

const resume = greenhouse.fields.find((f) => f.label === "Resume/CV")!;
assert.equal(resume.type, "file");
assert.equal(resume.required, true);
assert.equal(resume.kind, "document");
ok("the resume is a required file, and known to be a document");

assert.equal(kindOf(greenhouse, /legally authorized/i), "standing");
assert.equal(kindOf(greenhouse, /sponsorship/i), "standing");
ok("work authorization and sponsorship are standing answers, not guesses");

console.log("\n2. lever, where the form is ordinary HTML");

const lever = parseLever(
  fixture("lever-spotify-apply.html"),
  "https://jobs.lever.co/spotify/05b8d6ee-0773-4255-b8b9-ae73d74a5ee5/apply",
);

assert.ok(lever.fields.length >= 8, `only ${lever.fields.length} fields`);
ok(`read ${lever.fields.length} fields`);

const byRef = (ref: string) => lever.fields.find((f) => f.ref === ref);
assert.equal(byRef("resume")?.type, "file");
assert.equal(byRef("email")?.kind, "identity");
assert.ok(byRef("urls[LinkedIn]"), "the LinkedIn url field was dropped");
assert.equal(byRef("urls[LinkedIn]")?.kind, "link");
ok("files, identity and links are told apart");

assert.equal(byRef("pronouns")?.kind, "eeo");
ok("pronouns count as self-identification, not as a question to answer");

const repeated = byRef("pronouns");
assert.ok((repeated?.options?.length ?? 0) > 1, "a repeated checkbox became one field with options");
ok("a field repeated once per option is one field");

console.log("\n2b. and its survey is read as questions, not as unlabelled inputs");

/*
  The failure this guards against: lever carries the employer's questions
  and the self-identification survey as escaped JSON in hidden inputs, and
  a parser reading only the visible markup reported nine unlabelled
  "custom" fields — the kind that gets drafted and answered.
*/
const unreadable = lever.fields.filter((f) => /^(cards|surveysResponses)\[/.test(f.label));
assert.deepEqual(unreadable, [], "a field was reported under its form name, with no question text");
ok("no field is reported as a raw form name");

const gender = lever.fields.find((f) => /gender/i.test(f.label));
assert.ok(gender, "the gender question was not found at all");
assert.equal(gender.kind, "eeo");
assert.ok((gender.options?.length ?? 0) >= 3, "its options were lost");
ok("the gender question is read, with its options, as self-identification");

assert.equal(
  lever.fields.filter((f) => f.kind === "eeo").length >= 3,
  true,
  "the survey's race and veteran questions should be eeo too",
);
ok("so are the rest of the survey");

const card = lever.fields.find((f) => /previously employed/i.test(f.label));
assert.equal(card?.kind, "custom");
assert.equal(card?.type, "select");
ok("the employer's own card question keeps its wording and its options");

console.log("\n3. ashby, where the form is typed already");

const ashby = parseAshby(
  fixture("ashby-decagon.json"),
  "https://jobs.ashbyhq.com/decagon/67c794bd-e423-44b2-8b80-d7b759994cde/application",
);

assert.ok(ashby.fields.length >= 8, `only ${ashby.fields.length} fields`);
ok(`read ${ashby.fields.length} fields`);
assert.equal(ashby.fields.find((f) => f.label === "Resume")?.type, "file");
assert.equal(ashby.fields.find((f) => f.label === "Email")?.type, "email");
assert.equal(kindOf(ashby, /visa sponsorship/i), "standing");
assert.equal(kindOf(ashby, /college\/university/i), "custom");
ok("their own question is custom; the sponsorship one is not");

console.log("\n4. the keyword fallback fails safe");

for (const label of [
  "Gender",
  "Race / Ethnicity",
  "Are you Hispanic or Latino?",
  "Veteran status",
  "Voluntary Self-Identification of Disability",
  "What are your pronouns?",
]) {
  assert.equal(byWords(label), "eeo", `${label} was not treated as self-identification`);
}
ok("every self-identification wording lands in eeo");

for (const label of ["What is your favourite build tool?", "Tell us about a hard bug", ""]) {
  assert.equal(byWords(label), "custom", `${label} should fall through to custom`);
}
ok("anything unrecognised falls through to the person");

console.log("\n5. a heading outranks a label");

/*
  The bug this is here for: the demographic survey on Spotify's form opens by
  asking for a country, in the same words as the contact field at the top of
  the same page. Read as a label it is an address, and it was filled from the
  profile.
*/
assert.equal(byWords("What is your location?"), "identity");
assert.equal(byWords("What is your location?", "Demographic Survey"), "eeo");
ok("the same question is a contact detail in one section and a disclosure in another");

assert.ok(isVoluntarySection("Demographic Questions for Spotify"));
assert.ok(isVoluntarySection("U.S. Equal Employment Opportunity information"));
assert.ok(isVoluntarySection("Voluntary Self-Identification"));
assert.ok(!isVoluntarySection("Previous Spotify Employment"));
assert.ok(!isVoluntarySection(undefined));
ok("a voluntary heading is recognised and an ordinary one is not");

const location = lever.fields.find((field) => /what is your location/i.test(field.label));
assert.ok(location, "the survey's country select was not reported at all");
assert.equal(location?.kind, "eeo");
assert.equal(location?.section, "Demographic Survey");
ok("lever's nameless country select is read, and read as part of the survey");

const surveyed = lever.fields.filter((field) => field.kind === "eeo");
assert.ok(surveyed.length >= 4, `only ${surveyed.length} voluntary fields found`);
assert.ok(
  surveyed.every((field) => field.section !== undefined),
  "a voluntary field came through with no section",
);
ok("every question in a lever survey carries the heading it was asked under");

console.log("\n6. it can say what an application wants, in a sentence");

const summary = describeForm(greenhouse);
assert.match(summary, /greenhouse/);
assert.match(summary, /Resume\/CV/);
assert.ok(summary.length < 1200, "a summary nobody will read is not a summary");
ok("the summary names the board and the documents");

console.log(`\n${passed} passed, 0 failed`);
