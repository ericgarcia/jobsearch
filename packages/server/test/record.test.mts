/*
  What went on the form, and what deliberately did not.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/record.test.mts
*/

import assert from "node:assert/strict";
import { migrate, run } from "../src/db/client.js";
import { listAnswers, markApplied, recordAnswers } from "../src/apply/record.js";
import * as repo from "../src/repo.js";

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

console.log("\n1. What was filled in is written down");

await recordAnswers(1, [
  { label: "Email", kind: "identity", value: "ada@example.com" },
  { label: "Are you legally authorized to work?", kind: "standing", value: "Yes" },
  { label: "Why do you want to work here?", kind: "custom", value: "Because of the compiler team." },
]);

const stored = await listAnswers(1);
assert.equal(stored.length, 3);
assert.equal(stored.find((row) => row.label === "Email")?.value, "ada@example.com");
assert.equal(
  stored.find((row) => /Why do you want/.test(row.label))?.value,
  "Because of the compiler team.",
);
ok("every answer comes back as it went in");

console.log("\n2. A self-identification answer is recorded without its answer");

/*
  The row exists so the record is complete — the section was answered — and
  the value is not copied into a second table. Someone's disability status
  lives in one place.
*/
await recordAnswers(1, [
  { label: "What best describes your gender?", kind: "eeo", value: "Prefer not to disclose" },
]);

const withSelfId = await listAnswers(1);
const selfId = withSelfId.find((row) => row.kind === "eeo")!;
assert.ok(selfId, "the field should be recorded as answered");
assert.equal(selfId.value, null, "a self-identification value was written down");
assert.equal(
  JSON.stringify(withSelfId).includes("Prefer not to disclose"),
  false,
  "the value reached the record by another route",
);
ok("it says the question was answered and not what with");

console.log("\n3. Filling again corrects rather than duplicates");

await recordAnswers(1, [{ label: "Email", kind: "identity", value: "ada@newmail.example" }]);
const corrected = await listAnswers(1);
assert.equal(corrected.filter((row) => row.label === "Email").length, 1);
assert.equal(corrected.find((row) => row.label === "Email")?.value, "ada@newmail.example");
ok("one row per question, holding the last thing put in it");

console.log("\n4. Applied is the person's word, and it is dated");

const before = await repo.getJob(1);
assert.ok(before?.status == null, "nothing should be tracked yet");

const result = await markApplied(1);
assert.equal(result.status, "applied");
const after = await repo.getJob(1);
assert.equal(after?.status, "applied");
assert.ok(after?.applied_at, "the date it was sent was not stamped");
ok("the job moves to applied and the date is kept");

await markApplied(1);
assert.equal((await repo.getJob(1))?.status, "applied");
ok("saying so twice is not an error");

console.log(`\n${passed} passed, 0 failed`);
