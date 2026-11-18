/*
  Telling a thread that the rules changed under it.

  Written against a real failure. Asked to improve a bullet, the assistant
  refused on the grounds that the wording had to come from the person. The
  rule that made it say so was removed, and on its next turn in that same
  thread it refused again — "I can't write the new version myself, even
  though I can see it would help", which is the new rules arriving and losing
  to the old answer sitting in the context.

  The system prompt was never the problem: it is sent fresh on every turn,
  resumed turns included. What it cannot do is retract what the assistant
  already said. So the stamp here is not a cache — it is how a conversation
  finds out its own precedent is out of date.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/rules.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import * as repo from "../src/repo.js";
import { RULES_AT, SYSTEM_PROMPT } from "../src/agent/prompt.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

console.log("\n1. A thread's first turn has no precedent to correct");

const fresh = await repo.createConversation("first");
assert.equal(await repo.rulesChanged(fresh, RULES_AT), false);
ok("a conversation that has never run is told nothing");

console.log("\n2. Running under the same rules says nothing either");

assert.equal(await repo.rulesChanged(fresh, RULES_AT), false);
assert.equal(await repo.rulesChanged(fresh, RULES_AT), false);
ok("turn after turn under unchanged rules is silent");

console.log("\n3. Edited rules are announced once, not every turn");

/*
  Once is the whole point. A note on every turn would become part of the
  thread's own furniture and stop being read, which is how the rule it is
  correcting failed in the first place.
*/
assert.equal(await repo.rulesChanged(fresh, "something-else"), true);
assert.equal(await repo.rulesChanged(fresh, "something-else"), false);
ok("the first turn after a change is told, and the next one is not");

assert.equal(await repo.rulesChanged(fresh, RULES_AT), true);
assert.equal(await repo.rulesChanged(fresh, RULES_AT), false);
ok("and changing back is itself a change worth saying");

console.log("\n4. One thread's stamp is not another's");

const other = await repo.createConversation("second");
await repo.rulesChanged(other, "old-rules");
assert.equal(await repo.rulesChanged(fresh, RULES_AT), false);
assert.equal(await repo.rulesChanged(other, RULES_AT), true);
ok("each conversation is told about its own rules, not the newest thread's");

console.log("\n5. The fingerprint follows the rules it fingerprints");

assert.match(RULES_AT, /^[0-9a-f]{16}$/);
ok("it is a short hex digest, short enough to read in a row");

/*
  The property that makes the stamp worth storing: editing a word of the
  prompt has to produce a different stamp, or a thread goes on working to
  rules nobody has any more.
*/
const { createHash } = await import("node:crypto");
const ofEdited = createHash("sha256")
  .update(`${SYSTEM_PROMPT} and one more sentence.`)
  .digest("hex")
  .slice(0, 16);
assert.notEqual(ofEdited, RULES_AT);
ok("one sentence added to the prompt is a different stamp");

console.log(`\n${passed} passed, 0 failed`);
