/*
  Filling a form, and refusing to send it.

  Both halves here are pure: a snapshot in, a list of fields out, and a rule
  about clicks. The browser calls around them are thin. This is the part with
  judgement in it, so this is the part with tests.

  Run: npx tsx test/fill.test.mts
*/

import assert from "node:assert/strict";
import {
  askedOf,
  chooseOption,
  planFill,
  questionsOf,
  readSnapshot,
  reportOf,
  type Known,
} from "../src/apply/fill.js";
import { classifyByWords, type Classified } from "../src/apply/classify.js";
import { SELF_ID_KEYS } from "../src/apply/answers.js";
import { refusal, wouldSend } from "../src/apply/guard.js";

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

/*
  A Playwright accessibility snapshot, in the shape its tools emit: role,
  accessible name, and a ref, with nesting by indentation.
*/
const SNAPSHOT = `
- document:
  - form "Application":
    - textbox "First Name" [ref=e10]
    - textbox "Last Name" [ref=e11]
    - textbox "Email" [ref=e12]
    - textbox "Phone" [ref=e13]
    - textbox "LinkedIn Profile" [ref=e14]
    - textbox "GitHub" [ref=e15]
    - button "Attach Resume" [ref=e16]
    - radiogroup "Are you legally authorized to work in the country where the job is located?":
      - radio "Yes" [ref=e20]
      - radio "No" [ref=e21]
    - radiogroup "Will you now or in the future require sponsorship?":
      - radio "Yes" [ref=e22]
      - radio "No" [ref=e23]
    - radiogroup "What best describes your gender?":
      - radio "Woman" [ref=e30]
      - radio "Man" [ref=e31]
      - radio "Prefer not to disclose" [ref=e32]
    - textbox "Why do you want to work here?" [ref=e40]
    - checkbox "Consent: marketing" [ref=e41]
`;

const known: Known = {
  profile: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 212 555 0101",
    location: "New York, NY",
    links: ["https://linkedin.com/in/ada", "https://github.com/ada"],
  },
  standing: [
    { topic: "work_authorization", answer: "Yes" },
    { topic: "sponsorship", answer: "No" },
  ],
  selfId: { gender: "Prefer not to disclose" },
  /*
    The tests that follow are about the matching, so they are run with the
    person having asked for every voluntary question. Section 9 is the one
    that checks what happens when they have not, which is the default, and
    the included set is per question rather than per section because that is
    how the decision is actually made — see answers.includedKeys.
  */
  include: new Set<string>(SELF_ID_KEYS),
};

console.log("\n1. Reading a snapshot");

const controls = readSnapshot(SNAPSHOT);
assert.equal(controls.find((c) => c.target === "e12")?.name, "Email");
assert.equal(controls.find((c) => c.target === "e20")?.role, "radio");
ok("roles, names and refs come through");

assert.equal(
  controls.find((c) => c.target === "e20")?.group,
  "Are you legally authorized to work in the country where the job is located?",
);
assert.equal(controls.find((c) => c.target === "e30")?.group, "What best describes your gender?");
ok("a radio knows which question it answers");

console.log("\n2. Planning what to type");

const plan = planFill(controls, known);
const valueFor = (target: string) => plan.fill.find((field) => field.target === target)?.value;

assert.equal(valueFor("e10"), "Ada");
assert.equal(valueFor("e11"), "Lovelace");
assert.equal(valueFor("e12"), "ada@example.com");
ok("a full name is split across first and last");

assert.equal(valueFor("e14"), "https://linkedin.com/in/ada");
assert.equal(valueFor("e15"), "https://github.com/ada");
ok("each link goes to the field that asks for it");

/*
  The two questions that share words and mean opposite things. Picking the
  wrong radio here tells an employer the opposite of the truth about
  someone's right to work.
*/
assert.equal(valueFor("e20"), "Yes", "authorization should be answered Yes");
assert.equal(valueFor("e23"), "No", "sponsorship should be answered No");
assert.equal(valueFor("e21"), undefined);
assert.equal(valueFor("e22"), undefined);
ok("authorisation and sponsorship get their own answers, not each other's");

console.log("\n3. What it refuses to touch");

const left = (match: RegExp) => plan.leftAlone.find((row) => match.test(row.name));
assert.ok(left(/Why do you want/), "their own question should be left");
assert.ok(left(/Consent/), "a consent should be left");
assert.match(left(/Consent/)!.why, /never ticked/i);
ok("the employer's question and the consent are left alone");

assert.equal(plan.fill.some((field) => field.name === "Attach Resume"), false);
ok("a file control is not typed into");

console.log("\n4. Self-identification is filled but never reported");

assert.equal(valueFor("e32"), "Prefer not to disclose");
ok("the stored answer is matched to the form's own wording");

const report = reportOf(plan);
assert.equal(report.self_identification_filled, 1);
const asText = JSON.stringify(report);
assert.equal(asText.includes("Prefer not to disclose"), false, "a self-identification value reached the report");
assert.equal(asText.includes("gender"), false, "the report named a self-identification field");
ok("the report counts them and says nothing else");

console.log("\n5. A stored answer that does not fit is left blank");

const mismatched = planFill(controls, {
  ...known,
  selfId: { gender: "Genderqueer" },
  standing: [{ topic: "work_authorization", answer: "Only with a visa" }],
});
assert.equal(mismatched.fill.some((f) => f.target.startsWith("e3")), false);
assert.ok(mismatched.leftAlone.some((row) => /gender/i.test(row.name)));
assert.ok(mismatched.leftAlone.some((row) => /legally authorized/i.test(row.name)));
ok("nothing is chosen on a weak match, in either store");

assert.equal(chooseOption("Yes", [{ role: "radio", name: "Yes", target: "a" }, { role: "radio", name: "Yes, with conditions", target: "b" }])?.target, "a");
assert.equal(chooseOption("maybe", [{ role: "radio", name: "Yes", target: "a" }]), null);
ok("an exact option wins over one that merely starts the same");

console.log("\n6. The send button is refused where it matters");

for (const [url, what] of [
  ["https://job-boards.greenhouse.io/scaleai/jobs/4658162005", "Submit application button"],
  ["https://jobs.lever.co/spotify/abc/apply", "the Submit button"],
  ["https://jobs.ashbyhq.com/decagon/abc/application", "Apply now"],
  ["https://jobs.lever.co/spotify/abc/apply", "Continue to the next page"],
  ["https://jobs.lever.co/spotify/abc/apply", "Next"],
] as const) {
  assert.equal(wouldSend(url, what), true, `${what} on ${url} should be refused`);
}
ok("submit, apply, send, continue and next are all stopped on an application page");

for (const [url, what] of [
  ["https://jobs.lever.co/spotify/abc/apply", "the resume upload button"],
  ["https://jobs.lever.co/spotify/abc/apply", "the Yes radio for work authorization"],
  ["https://www.example.com/news", "Submit comment"],
  [null, "Submit"],
] as const) {
  assert.equal(wouldSend(url, what), false, `${what} on ${url} should be allowed`);
}
ok("everything else on the page, and submit anywhere else, still works");

assert.match(refusal("Submit").reason, /by the app rather than by instruction/);
ok("the refusal says it is not a matter of persuasion");

console.log("\n6. A group of tick boxes is one question, not many");

/*
  Lever asks pronouns as ten checkboxes under one label. A checkbox counts
  as a question on its own — that is how a lone consent box stays visible —
  so every one of those ten was reported as its own question needing an
  answer written for this application: "He/him", "She/her", "They/them".
  Found on the first real form this ever filled.
*/
const PRONOUNS = `
- textbox "Full name ✱" [ref=e1]
- group "Pronouns":
  - checkbox "He/him" [ref=e2]
  - checkbox "She/her" [ref=e3]
  - checkbox "They/them" [ref=e4]
- checkbox "Consent: marketing" [ref=e5]
`;

const asked = planFill(readSnapshot(PRONOUNS), {
  ...known,
  selfId: { pronouns: "He/him" },
});

const named = (list: { name: string }[]) => list.map((row) => row.name);
for (const one of ["She/her", "They/them"]) {
  assert.ok(!named(asked.leftAlone).includes(one), `${one} is an option, not a question`);
  assert.ok(!named(asked.fill).includes(one), `${one} must not be reported as a question`);
}
ok("the individual tick boxes are not questions");

assert.ok(
  named(asked.leftAlone).includes("Consent: marketing"),
  "a lone checkbox is still a consent, and still reported",
);
ok("a consent on its own is unaffected");

const pronouns = asked.fill.find((field) => field.name === "Pronouns");
assert.ok(pronouns, "the group is answered as one question");
assert.equal(pronouns?.target, "e2", "the tick that gets set is the stored one");
assert.equal(pronouns?.kind, "eeo");
ok("the group is one question, recorded under its own label");

assert.equal(named(asked.fill).includes("Full name ✱"), false);
assert.ok(named(asked.fill).includes("Full name"), "the required mark is not part of the question");
ok("the required mark is stripped from what is recorded");

console.log("\n7. A list is only given something on it");

/*
  Lever's demographic question "What is your location?" is a list of every
  country. The stored location is a city: "New York, New York, United
  States". Every matching rule looked for the stored answer inside an
  option, nothing matched, and the value was sent as written — so the
  browser hunted five seconds for a country called "New York, New York,
  United States" and timed out, which failed the whole form fill.
*/
const countries = [
  { role: "option", name: "Select...", target: "c0" },
  { role: "option", name: "India", target: "c1" },
  { role: "option", name: "Oman", target: "c2" },
  { role: "option", name: "Romania", target: "c3" },
  { role: "option", name: "United States", target: "c4" },
  { role: "option", name: "United States Minor Outlying Islands", target: "c5" },
];

assert.equal(chooseOption("New York, New York, United States", countries)?.name, "United States");
ok("the option the stored answer names is the one chosen");

/*
  Whole words, and not fussiness: "Romania" contains "oman", so a plain
  substring test declares someone a resident of Oman.
*/
assert.equal(chooseOption("Bucharest, Romania", countries)?.name, "Romania");
ok("a country spelled inside another country's name is not matched");

assert.equal(chooseOption("Lagos, Nigeria", countries), null);
ok("a country the list does not offer is no answer at all");

const LIST = `
- combobox "What is your location?" [ref=e1]:
  - option "Select..." [ref=e2]
  - option "United States" [ref=e3]
  - option "Romania" [ref=e4]
`;

const far = planFill(readSnapshot(LIST), {
  ...known,
  profile: { ...known.profile, location: "New York, New York, United States" },
});
const chosen = far.fill.find((field) => field.name === "What is your location?");
assert.equal(chosen?.value, "United States", "the page's own wording is what gets sent");
ok("a select is filled with the option, not with the stored sentence");

const nowhere = planFill(readSnapshot(LIST), {
  ...known,
  profile: { ...known.profile, location: "Lagos, Nigeria" },
});
assert.equal(
  nowhere.fill.find((field) => field.name === "What is your location?"),
  undefined,
  "nothing is forced into a list that does not offer it",
);
assert.match(
  nowhere.leftAlone.find((row) => row.name === "What is your location?")?.why ?? "",
  /Nothing in this list matches/,
  "and it is said out loud",
);
ok("an unmatched list is left alone and reported, not typed into");

console.log("\n8. The payload is the shape the browser tool demands");

/*
  This is the test that was missing, and the one that cost a live run.

  Every planned field went out as `ref`, because that is what the snapshot
  calls it and what this file's own fixtures called it. The browser tool
  requires `target`, so it rejected all seven fields of a real application in
  one go. Nothing above would have noticed: the planner was right about every
  value, and wrong only about the name it sent them under.

  So this asserts the wire contract itself, copied from the tool's schema:
  the required keys, nothing unknown alongside them, and a `type` the tool's
  enum actually contains.
*/
const REQUIRED = ["target", "name", "type", "value"] as const;
const ALLOWED = new Set([...REQUIRED, "element", "kind"]);
const TYPES = new Set(["textbox", "checkbox", "radio", "combobox", "slider"]);

assert.ok(plan.fill.length > 0, "there is something to check");
for (const field of plan.fill) {
  for (const key of REQUIRED) {
    assert.ok(
      typeof (field as unknown as Record<string, unknown>)[key] === "string" &&
        ((field as unknown as Record<string, string>)[key] ?? "") !== "",
      `${field.name} is missing ${key}`,
    );
  }
  for (const key of Object.keys(field)) {
    assert.ok(ALLOWED.has(key), `${field.name} carries an unknown key ${key}`);
  }
  assert.ok(TYPES.has(field.type), `${field.name} has a type the tool rejects: ${field.type}`);
}
ok("each planned field carries target, name, type and value, and a type the tool accepts");

console.log("\n9. A voluntary section is blank unless they asked for it");

/*
  Storing an answer is not permission to send it. This is the default: the
  values are on file, they match the form's options exactly, and nothing is
  filled because nobody said to for this employer.
*/
const unasked = planFill(controls, { ...known, include: new Set<string>() });
assert.equal(unasked.fill.some((field) => field.kind === "eeo"), false);
assert.equal(reportOf(unasked).self_identification_filled, 0);
ok("a stored answer that matches perfectly is still not filled in");

const held = unasked.leftAlone.find((row) => /gender/i.test(row.name));
assert.ok(held, "the question was not reported as left alone either");
assert.match(held?.why ?? "", /have not asked/);
ok("it says why it is blank, so nobody has to wonder");

console.log("\n10. What a question means comes from the classifier, not its words");

/*
  The failure this is built around. Lever's demographic survey opens by
  asking for a country, in the same words as the contact field at the top of
  the same page. By its label it is an address, and it was answered from the
  profile — the person's city disclosed to a demographic survey they never
  agreed to answer.

  The heading is in the snapshot, so the classifier is given it, and its
  verdict is what the plan follows.
*/
const SURVEY = `
- textbox "Current location" [ref=e1]
- heading "Demographic Survey" [level=4]
- combobox "What is your location?" [ref=e2]:
  - option "United States" [ref=e3]
  - option "United Kingdom" [ref=e4]
`;

const paged = readSnapshot(SURVEY);
assert.equal(paged.find((control) => control.target === "e1")?.section, undefined);
assert.equal(paged.find((control) => control.target === "e2")?.section, "Demographic Survey");
ok("a control carries the heading it sits under, and one above it does not");

const questions = askedOf(paged);
const country = questions.find((question) => /what is your location/i.test(question.label));
assert.equal(country?.section, "Demographic Survey");
assert.deepEqual(country?.options, ["United States", "United Kingdom"]);
ok("the classifier is given the heading and the choices, which are the form's own words");

assert.equal(questionsOf(paged).length, 2, "the page asks two questions");

const verdicts = new Map<string, Classified>([
  ["Current location", { kind: "identity", slot: "location", by: "model" }],
  ["What is your location?", { kind: "eeo", key: "location", by: "model" }],
]);

const judged = planFill(paged, { ...known, include: new Set<string>() }, verdicts);
assert.equal(judged.fill.some((field) => field.target === "e2"), false);
assert.ok(judged.leftAlone.some((row) => /what is your location/i.test(row.name)));
ok("the survey's country is left blank, though its label reads as an address");

assert.equal(
  judged.fill.find((field) => field.target === "e1")?.value,
  "New York, NY",
  "the contact field above it is still filled",
);
ok("and the contact field of the same name is still answered");

/*
  The other half of the same bug. The profile holds a city; a field asking
  for a country has nothing on file to answer it, and the pattern that read
  both as "location" put the city in the country box.
*/
const COUNTRIES = `
- combobox "Country" [ref=e7]:
  - option "United States" [ref=e8]
- textbox "Postcode" [ref=e9]
- textbox "City" [ref=e10]
`;
const addressed = planFill(
  readSnapshot(COUNTRIES),
  { ...known, include: new Set<string>() },
  new Map<string, Classified>([
    ["Country", { kind: "identity", slot: "country", by: "model" }],
    ["Postcode", { kind: "identity", slot: "postcode", by: "model" }],
    ["City", { kind: "identity", slot: "city", by: "model" }],
  ]),
);
assert.equal(addressed.fill.some((field) => /country|postcode/i.test(field.name)), false);
assert.equal(addressed.fill.find((field) => field.name === "City")?.value, "New York, NY");
assert.ok(addressed.leftAlone.some((row) => row.name === "Country" && /nothing for country/i.test(row.why)));
ok("a city answers a city, and nothing answers a country or a postcode");

/*
  With the section it is a disclosure, and the stored country answers it —
  never the profile's city, which was given as a contact detail.
*/
const agreed = planFill(
  paged,
  { ...known, selfId: { location: "United States" } },
  verdicts,
);
assert.equal(agreed.fill.find((field) => field.target === "e2")?.value, "United States");
assert.equal(agreed.fill.find((field) => field.target === "e2")?.kind, "eeo");
ok("once they ask for it, the stored country answers it and the profile is not used");

const noKey = planFill(paged, { ...known, selfId: {} }, verdicts);
assert.ok(noKey.leftAlone.some((row) => /nothing stored/i.test(row.why)));
ok("with nothing stored for it, it is blank and says so");

console.log("\n11. A resolved option is filled in the form's own words");

/*
  What the string rules cannot do. No part of "Mixed: White and Asian" looks
  like the token `two_or_more`, and "Only with a visa" looks like neither
  "Yes, now or in the future" nor "No". Both are read by apply/choose.ts,
  which hands back the option text; from there it is treated as a stored
  answer that happens to match exactly.

  A token that a form's wording does begin with — "white" against "White:
  Any other White background" — is settled by the string rules before any of
  this, which is why they are kept.
*/
const HARD = `
- radiogroup "What best describes your ethnicity?":
  - radio "Asian/Asian British: Indian" [ref=e20]
  - radio "Mixed: White and Asian" [ref=e21]
  - radio "Prefer not to say" [ref=e22]
- combobox "Do you require visa sponsorship?" [ref=e23]:
  - option "Yes, now or in the future" [ref=e24]
  - option "No" [ref=e25]
`;

const hard = readSnapshot(HARD);
const hardKinds = new Map<string, Classified>([
  ["What best describes your ethnicity?", { kind: "eeo", key: "race", by: "model" }],
  ["Do you require visa sponsorship?", { kind: "standing", topic: "sponsorship", by: "model" }],
]);

const unresolved = planFill(
  hard,
  { ...known, selfId: { race: "two_or_more" }, standing: [{ topic: "sponsorship", answer: "Only with a visa" }] },
  hardKinds,
);
assert.equal(unresolved.fill.length, 0);
assert.equal(unresolved.leftAlone.length, 2);
ok("without a reading, both are left alone rather than approximated");

const resolved = planFill(
  hard,
  { ...known, selfId: { race: "two_or_more" }, standing: [{ topic: "sponsorship", answer: "Only with a visa" }] },
  hardKinds,
  new Map([
    ["What best describes your ethnicity?", "Mixed: White and Asian"],
    ["Do you require visa sponsorship?", "Yes, now or in the future"],
  ]),
);

assert.equal(resolved.fill.find((field) => field.target === "e21")?.kind, "eeo");
ok("the radio the stored token means is the one ticked");

const sponsorship = resolved.fill.find((field) => field.name === "Do you require visa sponsorship?");
assert.equal(sponsorship?.value, "Yes, now or in the future");
assert.equal(sponsorship?.type, "combobox");
ok("and a list is given the option, not the sentence the person wrote");

assert.equal(resolved.leftAlone.length, 0);
assert.equal(
  JSON.stringify(reportOf(resolved)).includes("two_or_more"),
  false,
  "a stored token reached the report",
);
ok("nothing is left over, and the token never appears in what is reported");

/*
  A resolved option is still only an option. One that the page does not
  offer cannot be clicked, and must not be typed in instead.
*/
const invented = planFill(
  hard,
  { ...known, selfId: { race: "two_or_more" } },
  hardKinds,
  new Map([["What best describes your ethnicity?", "Two or more races"]]),
);
assert.equal(invented.fill.some((field) => field.kind === "eeo"), false);
assert.ok(invented.leftAlone.some((row) => /ethnicity/i.test(row.name)));
ok("an option the form does not offer is left alone, not invented");

console.log("\n12. The keyword layer is still there, and still fails safe");

assert.equal(classifyByWords({ label: "What is your location?" }).kind, "identity");
assert.equal(
  classifyByWords({ label: "What is your location?", section: "Demographic Survey" }).kind,
  "eeo",
);
assert.equal(classifyByWords({ label: "Tell us about a hard bug" }).kind, "custom");
assert.equal(
  classifyByWords({ label: "Are you legally authorized to work in the US?" }).topic,
  "work_authorization",
);
assert.equal(classifyByWords({ label: "What are your pronouns?" }).key, "pronouns");
ok("the fallback classifies by words, section first, and says which route it was");

console.log(`\n${passed} passed, 0 failed`);
