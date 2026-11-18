/*
  Filling a form, and refusing to send it.

  Both halves here are pure: a snapshot in, a list of fields out, and a rule
  about clicks. The browser calls around them are thin. This is the part with
  judgement in it, so this is the part with tests.

  Run: npx tsx test/fill.test.mts
*/

import assert from "node:assert/strict";
import { chooseOption, planFill, readSnapshot, reportOf, type Known } from "../src/apply/fill.js";
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

console.log("\n7. The payload is the shape the browser tool demands");

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

console.log(`\n${passed} passed, 0 failed`);
