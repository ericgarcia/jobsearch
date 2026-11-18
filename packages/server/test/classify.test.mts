import assert from "node:assert/strict";
import { migrate, all, run } from "../src/db/client.js";
import {
  cached,
  classifyAsked,
  classifyByWords,
  fingerprint,
  forget,
  remember,
  type Asked,
} from "../src/apply/classify.js";

/**
 * What an application field is asking, and how long an answer to that is
 * trusted.
 *
 * The classification itself is a model call, so what is tested here is
 * everything around it: the cache that stops the second employer's identical
 * question costing anything, the three ways a cached judgement expires, and
 * the fallback for a machine with no credential. A judgement cached forever
 * is a judgement that can never be corrected, in the one part of this app
 * whose mistakes are sent to an employer in somebody's name.
 */

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

await migrate();

/*
  No credential, so nothing in this file reaches the network. The database is
  a fresh temp directory, so there is no stored one either, and these two
  would be read from the environment.
*/
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const authorized: Asked = {
  label: "Are you legally authorized to work in the United States?",
  options: ["Yes", "No"],
};

console.log("\n1. A verdict is remembered, and comes back marked as cached");

await remember(authorized, { kind: "standing", topic: "work_authorization", by: "model" });

const hit = await cached([fingerprint(authorized)]);
assert.equal(hit.get(fingerprint(authorized))?.kind, "standing");
assert.equal(hit.get(fingerprint(authorized))?.topic, "work_authorization");
assert.equal(hit.get(fingerprint(authorized))?.by, "cache");
ok("the kind and the topic survive the round trip, and the route is honest");

console.log("\n2. The heading is part of the key");

const plain: Asked = { label: "What is your location?" };
const surveyed: Asked = { label: "What is your location?", section: "Demographic Survey" };
assert.notEqual(fingerprint(plain), fingerprint(surveyed));
ok("the same question under a different heading is a different question");

/*
  And the choices are not part of the key. Every employer words a country
  list slightly differently, and paying to classify "What is your location?"
  once per wording is paying for nothing.
*/
assert.equal(
  fingerprint({ label: "Country", options: ["  United States"] }),
  fingerprint({ label: "Country", options: ["USA", "United Kingdom"] }),
);
ok("two wordings of the same choices are one cache entry");

console.log("\n3. Three ways a verdict expires");

const age = async (days: number) =>
  await run(
    `UPDATE field_classifications SET at = datetime('now', ?) WHERE fingerprint = ?`,
    `-${days} days`,
    fingerprint(authorized),
  );

await age(89);
assert.equal((await cached([fingerprint(authorized)])).size, 1);
ok("inside the window it is still trusted");

await age(91);
assert.equal((await cached([fingerprint(authorized)])).size, 0);
ok("past the window it is not");

await age(1);
await run(`UPDATE field_classifications SET rules = 'older-prompt' WHERE fingerprint = ?`, fingerprint(authorized));
assert.equal((await cached([fingerprint(authorized)])).size, 0);
ok("a verdict made under different rules is not trusted, however fresh");

await run(`UPDATE field_classifications SET rules = (SELECT rules FROM field_classifications LIMIT 1), model = 'some-other-model' WHERE fingerprint = ?`, fingerprint(authorized));
assert.equal((await cached([fingerprint(authorized)])).size, 0);
ok("nor is one made by a different model");

console.log("\n4. What has expired is thrown away");

await age(400);
await forget();
assert.equal(
  (await all<{ n: number }>(`SELECT count(*) AS n FROM field_classifications`))[0]?.n,
  0,
);
ok("an expired row is deleted rather than kept forever");

console.log("\n5. With no credential it falls back to the words");

const verdicts = await classifyAsked([
  { label: "Email" },
  { label: "What is your location?", section: "Demographic Survey" },
  { label: "Tell us about a hard bug you fixed" },
]);

assert.equal(verdicts.get("Email")?.kind, "identity");
assert.equal(verdicts.get("Email")?.slot, "email");
assert.equal(verdicts.get("What is your location?")?.kind, "eeo");
assert.equal(verdicts.get("Tell us about a hard bug you fixed")?.kind, "custom");
assert.equal(verdicts.get("Email")?.by, "words");
ok("every field is still classified, says it was by words, and the heading still wins");

assert.equal(
  (await all<{ n: number }>(`SELECT count(*) AS n FROM field_classifications`))[0]?.n,
  0,
);
ok("a keyword guess is never written to the cache");

assert.equal(classifyByWords({ label: "" }).kind, "custom");
ok("a field with no label at all goes to the person");

console.log(`\n${passed} passed, 0 failed`);
