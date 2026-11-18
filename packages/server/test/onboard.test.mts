/*
  Reading a resume into a profile, and what is left to ask.

  The model call is not exercised — these run without a credential — so what
  is checked is everything around it, which is where the profile could be
  damaged: that applying copies from the stored row and not from the caller,
  that nothing already there is overwritten, that running it twice does not
  double someone's career, and that a right to work is never imported however
  plainly a document shows one.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/onboard.test.mts
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, run } from "../src/db/client.js";
import {
  applyImport,
  getImport,
  listImports,
  proposeFrom,
  importHelp,
  importRoutes,
  readSource,
  vetFacts,
  whatIsMissing,
  type Proposed,
} from "../src/onboard.js";
import * as profile from "../src/profile.js";
import { declineStandingAnswer, setStandingAnswer } from "../src/apply/answers.js";
import { getFact, listFacts } from "../src/apply/facts.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-"));

/* A proposal written straight into the table, standing in for the call. */
const stash = async (proposal: Proposed, source = "resume") => {
  const written = await run(
    `INSERT INTO imports (source, origin, proposal) VALUES (?, NULL, ?)`,
    source,
    JSON.stringify(proposal),
  );
  return Number(written.lastInsertRowid);
};

const empty: Proposed = {
  profile: {},
  roles: [],
  education: [],
  skills: [],
  facts: [],
  unsure: [],
};

console.log("\n1. What can be read, and what is refused rather than guessed at");

fs.writeFileSync(path.join(scratch, "cv.md"), "# Ada Lovelace\n\nAnalytical engine work.\n");
assert.match(readSource(path.join(scratch, "cv.md")).text, /Analytical engine/);
assert.equal(readSource(path.join(scratch, "cv.md")).source, "resume");
ok("a text file is read, and called a resume");

fs.writeFileSync(path.join(scratch, "resume.pdf"), "%PDF-1.4 not really");
assert.throws(() => readSource(path.join(scratch, "resume.pdf")), /no text extractor/i);
ok("a PDF is refused with the reason, rather than read as rubbish");

fs.writeFileSync(path.join(scratch, "notes.bin"), "anything");
assert.throws(() => readSource(path.join(scratch, "notes.bin")), /Cannot read/i);
ok("and so is anything this app has no way to read");

assert.throws(() => readSource(path.join(scratch, "nothing-here.md")), /Nothing at/);
ok("a path that is not there says so");

const exported = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-"));
fs.writeFileSync(path.join(exported, "Positions.csv"), "Company Name,Title\nAcme,Engineer\n");
fs.writeFileSync(path.join(exported, "Skills.csv"), "Name\nRust\n");
const linkedin = readSource(exported);
assert.equal(linkedin.source, "linkedin");
assert.match(linkedin.text, /Positions\.csv[\s\S]*Acme/);
assert.match(linkedin.text, /Skills\.csv[\s\S]*Rust/);
ok("an unzipped LinkedIn export is read as the files it actually contains");

fs.writeFileSync(path.join(exported, "..", "unrelated.txt"), "x");
assert.throws(() => readSource(scratch), /No LinkedIn export files/);
ok("and a folder that is not one says what it expected to find");

console.log("\n2. A proposal is not a profile");

const proposal: Proposed = {
  profile: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    location: "London",
    links: ["https://github.com/ada"],
  },
  roles: [
    {
      company: "Analytical Engines",
      title: "Mathematician",
      start_date: "1842",
      bullets: ["Wrote the first published algorithm.", "Described a general-purpose machine."],
    },
  ],
  education: [{ school: "Home tuition", degree: "Mathematics" }],
  skills: [{ name: "Mathematics", years: 20 }],
  facts: [
    {
      slug: "highest_degree",
      question: "What is your highest degree?",
      answer: "Private tuition in mathematics",
    },
  ],
  unsure: ["A date that might be 1843."],
};

const first = await stash(proposal);
assert.equal((await profile.listRoles()).length, 0);
assert.equal((await profile.getProfile()).name, null);
ok("storing the proposal puts nothing in the profile");

assert.equal((await getImport(first))?.applied_at, null);
assert.equal((await listImports()).length, 1);
ok("it is a row of its own, marked unapplied");

console.log("\n3. Applying it copies what was read");

const applied = await applyImport(first);
assert.equal(applied.roles, 1);
assert.equal(applied.bullets, 2);
assert.equal(applied.education, 1);
assert.equal(applied.skills, 1);
assert.equal(applied.facts, 1);
assert.deepEqual(applied.profile.sort(), ["email", "links", "location", "name"]);
ok("every part lands and is counted");

const roles = await profile.listRoles();
assert.equal(roles[0]?.company, "Analytical Engines");
assert.equal(roles[0]?.start_date, "1842");

const bullets = await profile.listBullets(roles[0]!.id);
assert.deepEqual(
  bullets.map((bullet) => bullet.text),
  ["Wrote the first published algorithm.", "Described a general-purpose machine."],
);
ok("the bullets are word for word what was read, in the order they were read");

assert.equal((await getFact("highest_degree"))?.answer, "Private tuition in mathematics");
assert.equal((await getFact("highest_degree"))?.source, `resume:${first}`);
ok("a fact from a document says which document it came from");

assert.ok((await getImport(first))?.applied_at);
ok("and the import is marked applied");

console.log("\n4. Nothing they have written themselves is overwritten");

const second = await stash({
  ...empty,
  profile: { name: "Someone Else", headline: "A headline they never wrote", email: "other@example.com" },
});
const over = await applyImport(second);

assert.equal((await profile.getProfile()).name, "Ada Lovelace");
assert.equal((await profile.getProfile()).email, "ada@example.com");
assert.deepEqual(over.profile, ["headline"]);
ok("a filled field stands, and only the empty one is taken");

console.log("\n5. The same career twice is not two careers");

/*
  A resume and then the LinkedIn export of the same history is the ordinary
  way this gets used twice, and it should not double anything.
*/
const again = await stash(proposal, "linkedin");
const twice = await applyImport(again);
assert.equal(twice.roles, 0);
assert.equal(twice.bullets, 0);
assert.equal(twice.education, 0);
assert.equal((await profile.listRoles()).length, 1);
ok("the same company and title is skipped, and so is the school");

console.log("\n6. Only the parts they asked for");

const third = await stash({
  ...empty,
  roles: [
    { company: "One", title: "Engineer", bullets: ["a"] },
    { company: "Two", title: "Engineer", bullets: ["b"] },
    { company: "Three", title: "Engineer", bullets: ["c"] },
  ],
  skills: [{ name: "Go" }, { name: "Zig" }],
});

const some = await applyImport(third, { roles: [0, 2], skills: [], profile: false });
assert.equal(some.roles, 2);
assert.equal(some.skills, 0);
assert.deepEqual(some.profile, []);
assert.deepEqual(
  (await profile.listRoles())
    .map((role) => role.company)
    .filter((company) => ["One", "Two", "Three"].includes(company))
    .sort(),
  ["One", "Three"],
);
ok("named items are taken, an empty list takes none, and the rest is left");

console.log("\n7. A right to work is never imported");

/*
  The check that matters most here. A document showing a London address and
  fifteen years of UK employment does not say anybody may work in the UK, and
  nothing in this app may decide that it does — being wrong misstates
  someone's legal position to an employer. The prompt says so; this says so
  again, because a prompt can be misread and this cannot.
*/
const sneaky = await stash({
  ...empty,
  facts: [
    { slug: "work_authorization", question: "Are you authorised to work in the UK?", answer: "Yes" },
    { slug: "visa_status", question: "What is your visa status?", answer: "Settled" },
    { slug: "sponsorship_needed", question: "Do you need sponsorship?", answer: "No" },
    { slug: "highest_degree", question: "What is your highest degree?", answer: "BSc" },
  ],
});

/*
  Written straight into the table and then accepted in full, so this is the
  write being stopped rather than the read. Both layers matter: one keeps a
  wrong suggestion away from the person, the other keeps a wrong answer off a
  form, and only the second reaches an employer.
*/
const letThrough = await applyImport(sneaky, { facts: [0, 1, 2, 3] });
assert.equal(letThrough.facts, 1);
assert.equal(await getFact("work_authorization"), null);
assert.equal(await getFact("visa_status"), null);
assert.equal(await getFact("sponsorship_needed"), null);
ok("accepting all four stores one, and none of the three about working legally");

const hopeful = await vetFacts([
  { slug: "work_authorization", question: "Are you authorised to work in the UK?", answer: "Yes" },
  { slug: "right_to_work", question: "Do you have the right to work here?", answer: "Yes" },
  { slug: "nationality", question: "Are you a British citizen?", answer: "Yes" },
  { slug: "gender", question: "Something harmless-looking?", answer: "x" },
  { slug: "security_clearance", question: "Do you hold a clearance?", answer: "No" },
]);
assert.deepEqual(
  hopeful.map((fact) => fact.slug),
  ["security_clearance"],
);
ok("and the same filter drops them by name, by wording, and by voluntary key");

console.log("\n8. What is still missing, and what is not missing at all");

const missing = await whatIsMissing();
assert.equal(missing.ready, true);
assert.ok(!missing.gaps.includes("name"));
assert.ok(!missing.gaps.includes("work history"));
ok("a profile with a name, an email and a role is ready to apply with");

assert.ok(missing.unanswered.some((question) => question.slug === "sponsorship"));
ok("the app's own questions with no answer are listed");

/*
  And a refusal is not a gap. That distinction is the reason the fact store
  exists, and a "what is missing" list that ignored it would put a refused
  question in front of someone on every visit.
*/
await declineStandingAnswer("salary");
await setStandingAnswer("notice_period", "Three months");
const after = await whatIsMissing();
assert.equal(after.unanswered.some((question) => question.slug === "salary"), false);
assert.equal(after.unanswered.some((question) => question.slug === "notice_period"), false);
ok("neither a refusal nor an answer is something still to ask");

assert.deepEqual(after.asked, []);
ok("and with no credential it suggests nothing rather than suggesting rubbish");

console.log("\n9. Reading needs a credential, and says so");

await assert.rejects(() => proposeFrom("Some resume text", "resume"), /credential/i);
ok("it refuses with the reason, rather than storing an empty proposal");

await assert.rejects(() => proposeFrom("   ", "resume"), /nothing to read/i);
ok("and an empty document is never sent anywhere");

await assert.rejects(() => applyImport(9999), /No import with id/);
ok("applying something that does not exist fails rather than doing nothing quietly");

console.log("\n10. The routes out of LinkedIn say what they can and cannot do");

/*
  These are instructions a person will follow, so the thing worth asserting is
  that the app never recommends a route it cannot finish. The PDF route is
  listed because it is how most people would think to do this, and it is
  marked unready because a PDF cannot be read here yet — the steps say to
  paste the text instead.
*/
const routes = importRoutes();
assert.equal(routes[0]?.ready, true);
assert.match(routes[0]?.name ?? "", /download your linkedin data/i);
ok("the route that works is first, and it is the complete one");

assert.ok(routes.every((route) => route.steps.length > 0 && route.caveats.length > 0));
ok("every route has steps and says where it falls short");

const pdf = routes.find((route) => /PDF/i.test(route.name))!;
assert.equal(pdf.ready, false);
assert.ok(pdf.caveats.some((caveat) => /paste/i.test(caveat)));
ok("the PDF route is marked unreadable and says what to do instead");

assert.match(importHelp().note, /forbids automated access/i);
ok("and the reason the exporting is theirs to do travels with the steps");

console.log(`\n${passed} passed, 0 failed`);
