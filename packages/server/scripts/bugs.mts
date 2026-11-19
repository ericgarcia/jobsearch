/*
  The bug reports the assistant filed, from a terminal.

  The admin page shows these too, and the page is the right place to read
  them as the person. This is for the other reader: whoever is going to fix
  one, who wants the attached state as text they can paste into a test and
  the conversation it happened in without clicking through a UI.

  It talks to the database rather than to the server, so it works whether or
  not the app is running — which it often is not, at the point somebody sits
  down to fix something.

    npm run bugs --workspace @jobsearch/server -- list
    npm run bugs --workspace @jobsearch/server -- show 3
    npm run bugs --workspace @jobsearch/server -- transcript 5
    npm run bugs --workspace @jobsearch/server -- fixed 3
    npm run bugs --workspace @jobsearch/server -- reopen 3

  See .claude/skills/fix-reported-bug/SKILL.md, which is written around it.
*/

import { all, migrate } from "../src/db/client.js";
import { bugReports, markFixed } from "../src/bugs.js";

const [command = "list", argument] = process.argv.slice(2);

await migrate();

function when(at: string): string {
  return at.replace("T", " ").slice(0, 19);
}

if (command === "list") {
  const bugs = await bugReports();
  const open = bugs.filter((one) => !one.fixed_at);
  const fixed = bugs.filter((one) => one.fixed_at);

  if (bugs.length === 0) {
    console.log("Nothing filed.");
  }
  for (const bug of open) {
    console.log(
      `${String(bug.id).padStart(3)}  ${bug.title}\n     ` +
        `seen ${bug.hits}×, last ${when(bug.last_at)}, ${bug.occurrences.length} kept`,
    );
  }
  if (fixed.length > 0) {
    console.log(`\n${fixed.length} marked fixed: ${fixed.map((one) => one.id).join(", ")}`);
  }
} else if (command === "show") {
  const id = Number(argument);
  const bug = (await bugReports()).find((one) => one.id === id);
  if (!bug) {
    console.error(`No report ${argument}.`);
    process.exit(1);
  }

  console.log(`#${bug.id}  ${bug.title}`);
  console.log(`seen ${bug.hits}×, first ${when(bug.first_at)}, last ${when(bug.last_at)}`);
  if (bug.fixed_at) console.log(`marked fixed ${when(bug.fixed_at)}`);
  console.log(`\n  doing     ${bug.doing}`);
  console.log(`  expected  ${bug.expected}`);
  console.log(`  happened  ${bug.happened}`);

  console.log(`\n${bug.occurrences.length} sighting(s), newest first:`);
  for (const seen of bug.occurrences) {
    const card = seen.context.card;
    console.log(`\n  ${when(seen.at)}`);
    console.log(`    said   ${seen.said}`);
    console.log(
      `    card   ${
        card
          ? `${card.action} on ${card.target}${card.target_id != null ? ` #${card.target_id}` : ""}` +
            `, field ${card.field}, answers ${card.answers.join("/")}, recommended ${card.recommend}` +
            `${card.question_id != null ? `, question ${card.question_id}` : ""}, up since ${card.at}`
          : "none waiting"
      }`,
    );
    console.log(`    thread ${seen.context.conversation ?? "none"}`);
    console.log(`    queue  ${seen.context.queue.settled} settled, ${seen.context.queue.left} left`);
  }

  const threads = [...new Set(bug.occurrences.map((one) => one.context.conversation))].filter(
    (one): one is number => one != null,
  );
  if (threads.length > 0) {
    console.log(
      `\nRead what was said: ${threads
        .map((one) => `npm run bugs --workspace @jobsearch/server -- transcript ${one}`)
        .join("\n                    ")}`,
    );
  }
} else if (command === "transcript") {
  const id = Number(argument);
  const said = await all<{ role: string; content: string; at: string }>(
    `SELECT role, content, at FROM messages WHERE conversation_id = ? ORDER BY id`,
    id,
  );
  if (said.length === 0) {
    console.error(`Nothing was said in conversation ${argument}, or there is no such thread.`);
    process.exit(1);
  }
  for (const line of said) {
    console.log(`\n[${when(line.at)}] ${line.role}\n${line.content}`);
  }
} else if (command === "fixed" || command === "reopen") {
  const id = Number(argument);
  const { ok } = await markFixed(id, command === "fixed");
  if (!ok) {
    console.error(`No report ${argument}.`);
    process.exit(1);
  }
  console.log(command === "fixed" ? `#${id} marked fixed.` : `#${id} is open again.`);
} else {
  console.error("Say: list, show <id>, transcript <conversation>, fixed <id>, reopen <id>.");
  process.exit(1);
}
