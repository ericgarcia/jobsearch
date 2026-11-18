import assert from "node:assert/strict";
import { migrate, all, run } from "../src/db/client.js";
import {
  cachedMeanings,
  canChoose,
  meaningsOf,
  rememberMeanings,
  voluntaryOption,
} from "../src/apply/choose.js";
import { SELF_ID_VALUES, isTokenised } from "../src/apply/answers.js";

/**
 * Matching a stored answer to the words a form uses.
 *
 * The voluntary half is what this file is mostly about, because it is the
 * half with a promise to keep: the model is asked what the employer's options
 * mean and never what the person answered, so the comparison happens here, in
 * code, on tokens. These tests cover that comparison, the cache that makes it
 * affordable, and its expiry.
 *
 * The model calls themselves are not exercised — there is no credential here
 * and nothing in this file reaches the network.
 */

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

await migrate();
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

console.log("\n1. The vocabulary is a closed set");

for (const [key, values] of Object.entries(SELF_ID_VALUES)) {
  assert.ok(values && values.length > 1, `${key} offers nothing to choose between`);
  assert.ok(
    values.some((value) => value.token === "decline"),
    `${key} does not let someone decline, which is always an answer`,
  );
  assert.equal(new Set(values.map((v) => v.token)).size, values.length, `${key} repeats a token`);
}
ok("every list has distinct tokens and lets the person decline");

assert.ok(isTokenised("gender"));
assert.ok(!isTokenised("location"), "a country is matched by its name, not a token");
assert.ok(!isTokenised("age"));
ok("the two that a form spells out are left as free text");

console.log("\n2. A UK ethnicity list, which no string rule can match");

/*
  The case that justifies the whole mechanism. Fourteen options and not one
  of them is the word "White" on its own, so a stored "white" matches nothing
  by prefix, substring or word. Asked what the options mean, it is one call.
*/
const UK = [
  "Asian/Asian British: Indian",
  "Black/Black British: African",
  "Mixed: White and Asian",
  "White: Any other White background",
  "White: English, Welsh, Scottish, Northern Irish or British",
  "Prefer not to say",
];

await rememberMeanings("race", "What best describes your ethnicity?", UK, new Map([
  ["Asian/Asian British: Indian", "asian"],
  ["Black/Black British: African", "black"],
  ["Mixed: White and Asian", "two_or_more"],
  ["White: Any other White background", "white"],
  ["White: English, Welsh, Scottish, Northern Irish or British", "white"],
  ["Prefer not to say", "decline"],
]));

const cached = await cachedMeanings("race", UK);
assert.equal(cached?.get("Prefer not to say"), "decline");
ok("a translation is remembered, and the option text is the key");

assert.equal(await voluntaryOption("race", "asian", "q", UK, {}), "Asian/Asian British: Indian");
ok("one option means what was stored, so that option is chosen");

assert.equal(await voluntaryOption("race", "white", "q", UK, {}), null);
ok("two options mean it, so neither is chosen — only they know which");

assert.equal(await voluntaryOption("race", "pacific_islander", "q", UK, {}), null);
ok("an answer this list does not offer is left blank, not approximated");

assert.equal(await voluntaryOption("race", "decline", "q", UK, {}), "Prefer not to say");
ok("declining is an answer, and it is given in the form's own words");

console.log("\n3. The option list is the cache key");

assert.notEqual(await cachedMeanings("race", [...UK].reverse()), null);
ok("the same options in another order are the same question, and cost nothing twice");

assert.equal(await cachedMeanings("race", UK.slice(1)), null);
ok("drop an option and it is a different question, because the answer might be the dropped one");

assert.equal(await cachedMeanings("gender", UK), null);
ok("and the same list asked about something else is read again");

console.log("\n4. The translation expires");

const age = async (days: number) =>
  await run(`UPDATE option_meanings SET at = datetime('now', ?)`, `-${days} days`);

await age(89);
assert.notEqual(await cachedMeanings("race", UK), null);
ok("inside the window it is still trusted");

await age(91);
assert.equal(await cachedMeanings("race", UK), null);
ok("past it, it is not");

await age(1);
await run(`UPDATE option_meanings SET rules = 'older-prompt'`);
assert.equal(await cachedMeanings("race", UK), null);
await run(`UPDATE option_meanings SET model = 'some-other-model'`);
assert.equal(await cachedMeanings("race", UK), null);
ok("a translation made under other rules, or by another model, is re-read");

console.log("\n5. With no credential, nothing is sent and nothing is guessed");

assert.equal(await canChoose(), null);
ok("it knows there is no credential to call with");

await assert.rejects(
  async () => await meaningsOf("race", "What best describes your ethnicity?", UK, {}),
  "an expired translation must not be served, and must not be invented either",
);
ok("an expired translation is not quietly reused");

assert.equal(
  (await all<{ n: number }>(`SELECT count(*) AS n FROM option_meanings WHERE self_id_key = 'gender'`))[0]?.n,
  0,
);
ok("nothing was written for a question that was never read");

console.log(`\n${passed} passed, 0 failed`);
