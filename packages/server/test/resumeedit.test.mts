/*
  A line typed on the page is checked exactly as a line the agent drafted.

  Editing a saved draft is new, and it is the one place where free text
  reaches a resume. The check that matters is numeric drift: a reworded
  bullet that gains a figure the stored fact does not support is how someone
  ends up defending a number they never achieved. `draftResume` has always
  checked that. If editing in place did not, the way to get an unchecked
  figure onto a resume would be to type it.
*/
import { migrate } from "../src/db/client.js";
import * as profile from "../src/profile.js";
import { draftResume, getResume, updateLine, updateResume } from "../src/resume.js";

await migrate();

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label} ${detail}`); }
};

const STORED = "Cut p95 latency from 900ms to 300ms";

const role = await profile.addRole({
  company: "Acme", title: "Engineer", location: null,
  start_date: "2020-01", end_date: null, summary: null,
});
const bullet = await profile.addBullet(role.id, STORED, []);
const { resumeId } = await draftResume({ jobId: null, label: "Base", lines: [{ bullet_id: bullet.id }] });
const line = (await getResume(resumeId)).lines[0]!;

console.log("\n1. A rewording that keeps the figures");
let saved = await updateLine(resumeId, line.id, "Cut p95 latency 900ms → 300ms");
check("it is kept", saved.text === "Cut p95 latency 900ms → 300ms");
check("with no warning", saved.warnings.length === 0, JSON.stringify(saved.warnings));
check("and the stored fact is untouched", (await profile.listBullets()).find((b) => b.id === bullet.id)?.text === STORED);

console.log("\n2. A rewording that invents one");
saved = await updateLine(resumeId, line.id, "Cut p95 latency by 90%");
check("it is still saved", saved.text === "Cut p95 latency by 90%");
check("and it is warned about", saved.warnings.length === 1, JSON.stringify(saved.warnings));
check("the warning names the figure", /90%/.test(saved.warnings[0] ?? ""), saved.warnings[0] ?? "");

console.log("\n3. The warning is on the draft, not only in the answer");
const reread = await getResume(resumeId);
check("re-reading the draft still shows it", reread.lines[0]!.warnings.length === 1);
check("and the draft counts it", reread.warnings.length === 1);
check("the stored wording is still there to compare with", reread.lines[0]!.source_text === STORED);

console.log("\n4. Emptying a line puts the stored wording back");
saved = await updateLine(resumeId, line.id, "   ");
check("the text is the stored one", saved.text === STORED);
check("nothing is held as a rewording", saved.rendered_text === null);
check("and the warning has gone with it", saved.warnings.length === 0);

console.log("\n5. A summary is checked against the whole profile");
let draft = await updateResume(resumeId, { summary: "Cut latency to 300ms across 14 services" });
check("the summary is saved", draft.summary?.includes("14 services") === true);
check("the unsupported figure is warned about", draft.summary_warnings.length === 1, JSON.stringify(draft.summary_warnings));
draft = await updateResume(resumeId, { summary: "Cut p95 latency to 300ms" });
check("a supported one is not", draft.summary_warnings.length === 0, JSON.stringify(draft.summary_warnings));

console.log("\n6. A line belongs to its own draft");
let refused = false;
try {
  await updateLine(resumeId + 1000, line.id, "anything");
} catch {
  refused = true;
}
check("another resume's id cannot reach it", refused);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
