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
import { execFileSync } from "node:child_process";
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
  documentForUpload,
  documentFrom,
  readSource,
  saveUpload,
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

/* A LinkedIn-shaped archive, for the hand-over tests at the end. */
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-zip-"));
fs.mkdirSync(path.join(exportDir, "Export"));
fs.writeFileSync(path.join(exportDir, "Export", "Positions.csv"), "Company Name,Title\nAcme,Engineer\n");
const archiveForTest = path.join(exportDir, "export.zip");
execFileSync("zip", ["-q", "-r", archiveForTest, "Export"], { cwd: exportDir });

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
const asText = readSource(path.join(scratch, "cv.md"));
assert.equal(asText.kind, "text");
assert.match(asText.kind === "text" ? asText.text : "", /Analytical engine/);
assert.equal(readSource(path.join(scratch, "cv.md")).source, "resume");
ok("a text file is read, and called a resume");

/*
  A PDF is handed over whole rather than extracted, so the bytes come back
  with the type to send them under. The model reads it; nothing in between
  parses it.
*/
fs.writeFileSync(path.join(scratch, "resume.pdf"), "%PDF-1.4 and some bytes");
const asFile = readSource(path.join(scratch, "resume.pdf"));
assert.equal(asFile.kind, "file");
assert.equal(asFile.kind === "file" ? asFile.media : "", "application/pdf");
ok("a PDF comes back as bytes to send, not as text somebody extracted");

fs.writeFileSync(path.join(scratch, "cv.docx"), "PK-ish but not really");
assert.throws(() => readSource(path.join(scratch, "cv.docx")), /Export it as a PDF/i);
ok("a Word file says what to do instead, since it cannot be read");

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
assert.equal(linkedin.kind, "text");
const exportedText = linkedin.kind === "text" ? linkedin.text : "";
assert.match(exportedText, /Positions\.csv[\s\S]*Acme/);
assert.match(exportedText, /Skills\.csv[\s\S]*Rust/);
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
assert.equal(twice.roles_already_there, 1);
assert.equal(twice.bullets, 0);
assert.equal(twice.education, 0);
assert.equal((await profile.listRoles()).length, 1);
ok("the same company and title is skipped, and so is the school");

console.log("\n5b. A role can come in without the lines that are not achievements");

/*
  What the first real document showed. A LinkedIn export put eleven lines
  under one job, of which one was something the person had done; the rest was
  the company describing itself — "We charge by the deliverable, not the
  hour." All-or-nothing meant importing that and deleting it afterwards.

  Choosing by number keeps the promise: which of their sentences may land is
  a decision, what the sentences say is not.
*/
const mixed = await stash({
  ...empty,
  roles: [
    {
      company: "MuffinLabs",
      title: "Founder",
      bullets: [
        "MuffinLabs offers:",
        "We charge by the deliverable, not the hour.",
        "Recent work: shipped a retrieval system handling 40k queries a day.",
      ],
    },
  ],
});

const trimmed = await applyImport(mixed, { roles: [{ index: 0, bullets: [2] }], profile: false });
assert.equal(trimmed.roles, 1);
assert.equal(trimmed.bullets, 1);
assert.equal(trimmed.bullets_left, 2);
ok("the role lands with the one line that was an achievement");

const muffin = (await profile.listRoles()).find((role) => role.company === "MuffinLabs")!;
assert.deepEqual(
  (await profile.listBullets(muffin.id)).map((bullet) => bullet.text),
  ["Recent work: shipped a retrieval system handling 40k queries a day."],
);
ok("and the sales copy is not in the profile at all, not even briefly");

const whole = await stash({
  ...empty,
  roles: [{ company: "Preact", title: "Founding ML Engineer", bullets: ["a", "b"] }],
});
const both = await applyImport(whole, { roles: [0], profile: false });
assert.equal(both.bullets, 2);
assert.equal(both.bullets_left, 0);
ok("a role named as a plain number still comes in whole");

const none = await stash({
  ...empty,
  roles: [{ company: "NuMundo", title: "CTO", bullets: ["x", "y"] }],
});
const bare = await applyImport(none, { roles: [{ index: 0, bullets: [] }], profile: false });
assert.equal(bare.roles, 1);
assert.equal(bare.bullets, 0);
assert.equal(bare.bullets_left, 2);
ok("and a role can come in with none of them, which is not the same as not coming in");

console.log("\n5c. Their own summary is not a list of achievements");

/*
  The root of the same bug. An About section is one piece of prose about a
  person; putting it under a job makes it read as things they did there.
*/
const about = await stash({
  ...empty,
  summary: "I build production ML systems and have done since 2012.",
});
const withSummary = await applyImport(about);
assert.ok(withSummary.profile.includes("summary"));
assert.equal(
  (await profile.getProfile()).summary,
  "I build production ML systems and have done since 2012.",
);
ok("it lands on the profile, where it belongs");

const other = await stash({ ...empty, summary: "Something they did not write." });
const kept = await applyImport(other);
assert.equal(kept.profile.includes("summary"), false);
assert.match((await profile.getProfile()).summary ?? "", /since 2012/);
ok("and a second import does not replace one they already have");

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

await assert.rejects(
  () => proposeFrom({ kind: "text", text: "Some resume text", source: "resume", origin: "" }),
  /credential/i,
);
ok("it refuses with the reason, rather than storing an empty proposal");

await assert.rejects(
  () => proposeFrom({ kind: "text", text: "   ", source: "resume", origin: "" }),
  /nothing to read/i,
);
ok("and an empty document is never sent anywhere");

await assert.rejects(() => applyImport(9999), /No import with id/);
ok("applying something that does not exist fails rather than doing nothing quietly");

console.log("\n10. The routes out of LinkedIn say what they can and cannot do");

/*
  These are instructions somebody will follow, so the thing worth asserting is
  that the app never recommends a route it cannot finish, and that the quick
  one is first. Save to PDF is three clicks; the full data download is a
  request, an email and a wait, and it is there for when the PDF has left
  something out.
*/
const routes = importRoutes();
assert.match(routes[0]?.name ?? "", /save your linkedin profile as a pdf/i);
assert.equal(routes[0]?.ready, true);
ok("the three-click route is first, and it works");

assert.ok(routes[0]?.steps.some((step) => /…|\.\.\./.test(step)));
ok("and its steps name the button that is actually on the page");

assert.match(routes[1]?.name ?? "", /download your full linkedin data/i);
assert.ok(routes[1]?.best_for.includes("complete"));
ok("the thorough one is second, and says what it is for");

assert.ok(routes.every((route) => route.ready));
assert.ok(routes.every((route) => route.steps.length > 0 && route.caveats.length > 0));
ok("every route can be finished, and every route says where it falls short");

assert.match(importHelp().note, /forbids automated access/i);
ok("and the reason the exporting is theirs to do travels with the steps");

console.log("\n11. A file is read from what they handed over, never from a path");

/*
  The whole of the agent's reach into the filesystem. It has no file tool at
  all; it gets an id for something the person dropped into the chat, and that
  id is matched against the folder's own listing rather than joined into a
  path — so nothing it sends can name a file outside it.
*/
const handed = saveUpload("My CV.pdf", Buffer.from("%PDF-1.4 pretend"));
assert.match(handed.id, /^[a-z0-9]+-[a-f0-9]+$/);
assert.equal(handed.name, "My CV.pdf");

const back = documentForUpload(handed.id);
assert.equal(back.kind, "file");
assert.equal(back.kind === "file" ? back.media : "", "application/pdf");
ok("what was handed over comes back, under the name it was given");

for (const bad of ["../../etc/passwd", "..", "", "nope", "/etc/passwd", "abcd-ef01"]) {
  assert.throws(() => documentForUpload(bad), /No file was handed over/, `${bad} was accepted`);
}
ok("and an id that names anything else is refused, however it is shaped");

const odd = saveUpload("../../../evil name?.pdf", Buffer.from("%PDF-1.4 pretend"));
assert.equal(odd.name.includes("/"), false);
assert.equal(odd.name.startsWith("."), false);
ok("a name that tries to climb out of the folder is flattened before it is written");

assert.throws(() => saveUpload("empty.pdf", Buffer.alloc(0)), /empty/i);
ok("an empty file is refused rather than sent");

console.log("\n12. A zip is recognised by its bytes, not only by its name");

const named = documentFrom("export.zip", fs.readFileSync(archiveForTest));
assert.equal(named.source, "linkedin");
assert.equal(named.kind, "text");
ok("an archive handed over as a zip is read as the export it is");

console.log(`\n${passed} passed, 0 failed`);
