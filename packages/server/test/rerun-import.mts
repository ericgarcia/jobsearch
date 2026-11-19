/*
  Re-read a document already uploaded, and apply it.

  Not a test: a one-off for re-running an import after the reader changed,
  against the live profile. It makes no rows of its own — applyImport does
  the deduplication it always does — and prints what came back so the new
  parts can be checked.

  Run: npx tsx test/rerun-import.mts <upload_id>
*/

import { applyImport, documentForUpload, proposeFrom } from "../src/onboard.js";
import { clearQueue, waitingQuestions } from "../src/queue.js";
import { migrate } from "../src/db/client.js";

const uploadId = process.argv[2];
if (!uploadId) throw new Error("Give the upload id.");

await migrate();

const putAway = await clearQueue();
console.log(`put away ${putAway} questions that were still waiting`);

const document = documentForUpload(uploadId);
console.log(`reading ${document.name ?? uploadId} (${document.kind})`);

const stored = await proposeFrom(document);
const proposal = stored.proposal;
console.log(
  `read: ${proposal.roles.length} roles, ${proposal.education.length} degrees, ` +
    `${proposal.facts.length} facts, ${proposal.unsure.length} unsure, ` +
    `${proposal.left_out.length} lines kept aside`,
);

for (const item of proposal.left_out) {
  console.log(`  left out${item.company ? ` from ${item.company}` : ""}: ${item.text.slice(0, 70)}…`);
}

const applied = await applyImport(stored.id);
console.log(`applied: ${JSON.stringify(applied)}`);

const waiting = await waitingQuestions();
console.log(`\n${waiting.length} questions now waiting; the ones that carry their text:`);
for (const question of waiting.filter((one) => one.value)) {
  console.log(
    `  [${question.id}] ${question.target ?? "no target"} ${question.target_id ?? ""} — ` +
      `${(question.value ?? "").slice(0, 60)}…`,
  );
}
