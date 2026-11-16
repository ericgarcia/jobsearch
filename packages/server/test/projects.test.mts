/*
  A project's long form must not escape onto the public page by default.

  This is the one property of the feature that fails silently. A blurb that
  does not render is noticed immediately; a candid narrative that renders
  when it should not is noticed by whoever reads it, which may be the person
  it is about.
*/
import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import * as profile from "../src/profile.js";
import { gatherContent } from "../src/layout/store.js";

await migrate();

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label} ${detail}`); }
};

const SECRET = "the vendor contract was a mess and I said so at the time";

const role = await profile.addRole({
  company: "Acme", title: "Engineer", location: null,
  start_date: "2020-01", end_date: null, summary: null,
});

const project = await profile.addProject({
  role_id: role.id,
  name: "Migration",
  blurb: "Moved the billing system off the mainframe.",
  narrative: SECRET,
});

console.log("\n1. The long form is private until it is published");
check("narrative_public starts at 0", project.narrative_public === 0);

let content = await gatherContent();
let rendered = JSON.stringify(content);
check("the blurb is in the content", rendered.includes("Moved the billing system"));
check("the narrative is not", !rendered.includes(SECRET));

console.log("\n2. Publishing it puts it through");
await profile.updateProject(project.id, { narrative_public: 1 });
content = await gatherContent();
rendered = JSON.stringify(content);
check("the narrative is now there", rendered.includes(SECRET));

await profile.updateProject(project.id, { narrative_public: 0 });
content = await gatherContent();
check("and private again", !JSON.stringify(content).includes(SECRET));

console.log("\n3. The fact-checker can always see it");
// Both ways round: the corpus is how a generated sentence is checked against
// what is true, so it must hold the narrative whether or not it is published.
const corpus = await profile.profileCorpus();
check("the corpus holds the narrative even when private", corpus.includes(SECRET));

console.log("\n4. A bullet remembers the project it came from");
const bullet = await profile.addBullet(role.id, "Cut billing runtime by half", ["sql"], project.id);
const stored = (await profile.listBullets(role.id)).find((b) => b.id === bullet.id);
check("project_id is kept", stored?.project_id === project.id, JSON.stringify(stored));

console.log("\n5. Prose sections are authored to be shown");
const section = await profile.addSection({ heading: "How I work", body: "Slowly, then all at once." });
check("is_public starts at 1", section.is_public === 1);
check("it reaches the page", JSON.stringify(await gatherContent()).includes("Slowly, then all at once"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
