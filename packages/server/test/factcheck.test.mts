import * as profile from "../src/profile.js";
import * as resume from "../src/resume.js";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
};

const role = profile.addRole({ company: "Acme", title: "Staff Engineer", location: null,
  start_date: "2021-01", end_date: null, summary: null });
const b1 = profile.addBullet(role.id, "Led a team of 3 engineers and cut p99 latency by 40%", ["leadership"]);
const b2 = profile.addBullet(role.id, "Migrated 12 services to Kubernetes with no downtime", ["k8s"]);

console.log("\n1. Inflated figures are caught");
const inflated = resume.draftResume({ jobId: null, lines: [
  { bullet_id: b1.id, rendered_text: "Led a team of 30 engineers and cut p99 latency by 60%" }]});
check("two warnings raised", inflated.warnings.length === 2, JSON.stringify(inflated.warnings));
check("flags the team size", inflated.warnings.some(w => w.includes("30")));
check("flags the percentage", inflated.warnings.some(w => w.includes("60%")));

console.log("\n2. Honest rewording passes");
const honest = resume.draftResume({ jobId: null, lines: [
  { bullet_id: b1.id, rendered_text: "Cut p99 latency 40% while leading 3 engineers" },
  { bullet_id: b2.id }]});
check("no warnings", honest.warnings.length === 0, JSON.stringify(honest.warnings));

console.log("\n3. Formatting differences are not false alarms");
const fmt = profile.addBullet(role.id, "Processed 1,200 orders per second at $2.5m scale");
const formatted = resume.draftResume({ jobId: null, lines: [
  { bullet_id: fmt.id, rendered_text: "Handled 1200 orders/sec at $2.5M scale" }]});
check("no warnings for 1,200 vs 1200 or $2.5m vs $2.5M", formatted.warnings.length === 0,
  JSON.stringify(formatted.warnings));

console.log("\n4. A resume cannot cite a bullet that does not exist");
try {
  resume.draftResume({ jobId: null, lines: [{ bullet_id: 999999, rendered_text: "Invented a whole job" }]});
  check("rejected", false, "it was accepted");
} catch (e) {
  check("rejected with a useful message", (e as Error).message.includes("not in the profile"));
}

console.log("\n5. An unsupported figure in a summary is caught");
const summarised = resume.draftResume({ jobId: null, summary: "15 years of experience leading teams of 50.",
  lines: [{ bullet_id: b1.id }]});
check("flags both unsupported figures", summarised.warnings.length === 2, JSON.stringify(summarised.warnings));

console.log("\n6. Markdown renders");
const md = resume.renderMarkdown(honest.resumeId);
check("includes the role", md.includes("Staff Engineer, Acme"));
check("includes a bullet", md.includes("Cut p99 latency 40%"));

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail === 0) console.log(md);
process.exit(fail === 0 ? 0 : 1);
