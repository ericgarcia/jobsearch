/*
  Telling a repeated job from a second one.

  Both halves of this are taken from one real profile, which is why it is
  worth a file of its own. A LinkedIn export wrote the same university two
  ways and a career came in twice; the obvious repair — ignore the
  parentheses, compare the title — would have collapsed three summer
  internships with the same title into one and deleted two jobs.

  The model call is not exercised; these run without a credential, so what is
  checked is the part that settles things for nothing and the direction it
  fails in.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/dedupe.test.mts
*/

import assert from "node:assert/strict";
import { migrate } from "../src/db/client.js";
import { asMonth, duplicates, plainlySame, plainName, sameSpell } from "../src/dedupe.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

console.log("\n1. One employer, written two ways");

assert.equal(
  plainName("University of Washington (Genome Sciences)"),
  plainName("University of Washington"),
);
ok("a department in brackets is the same university");

assert.equal(plainName("Keeper Security, Inc."), plainName("Keeper Security"));
assert.equal(plainName("Grail Inc."), plainName("Grail"));
ok("and a legal suffix is the same company");

/*
  Where it stops. Reducing further starts merging employers that are not the
  same one, and the cost of that is a job quietly disappearing.
*/
assert.notEqual(plainName("Intel Research"), plainName("Intel Research Seattle"));
assert.notEqual(plainName("Spotify"), plainName("Spotify Labs"));
ok("a word that is not a bracket or a suffix is left alone");

console.log("\n2. Dates as documents actually write them");

assert.equal(asMonth("2005-01"), asMonth("January 2005"));
assert.equal(asMonth("2005-01"), asMonth("Jan 2005"));
ok("the same month in three notations is one month");

assert.equal(asMonth("present"), null);
assert.equal(asMonth(""), null);
assert.equal(asMonth(null), null);
ok("an open end is nothing rather than a guess");

assert.notEqual(asMonth("2008-06"), asMonth("2007-06"));
ok("and a year apart is a year apart");

console.log("\n3. The three internships");

/*
  The case that decides the whole design. One employer, one title, three
  summers. Matching on employer and title alone would make these one job and
  delete two of them.
*/
const intel2008 = { company: "Intel Research", title: "Research Intern", start_date: "2008-06", end_date: "2008-09" };
const intel2007 = { company: "Intel Research Seattle", title: "Research Intern", start_date: "2007-06", end_date: "2007-09" };
const intel2006 = { company: "Intel Research Seattle", title: "Research Intern", start_date: "2006-04", end_date: "2006-10" };

assert.equal(plainlySame(intel2008, intel2007), false);
assert.equal(plainlySame(intel2007, intel2006), false);
ok("three internships with one title stay three jobs");

assert.equal(sameSpell(intel2007, intel2006), false);
ok("because the years do not overlap, whatever the names say");

console.log("\n4. The duplicate that started it");

const incoming = {
  company: "University of Washington (Genome Sciences)",
  title: "Research Assistant",
  start_date: "January 2005",
  end_date: "September 2010",
};
const onFile = {
  id: 11,
  company: "University of Washington",
  title: "Research Assistant",
  start_date: "2005-01",
  end_date: "2010-09",
};

assert.equal(plainlySame(incoming, onFile), true);
ok("the same job, written two ways, in two date formats, is one job");

/*
  And the other job at that university in the same years is not it. A
  research assistant and a lecturer are two jobs however much they overlap.
*/
const lecturer = {
  company: "University of Washington (Genome Sciences)",
  title: "Lecturer: Continuous‐time Linear Systems",
  start_date: "January 2008",
  end_date: "April 2008",
};
assert.equal(plainlySame(lecturer, onFile), false);
ok("a different position at the same place, in the same years, is not");

assert.equal(
  plainlySame(lecturer, {
    id: 12,
    company: "University of Washington",
    title: "Lecturer: Continuous-time Linear Systems",
    start_date: "2008-01",
    end_date: "2008-04",
  }),
  true,
);
ok("and a title differing by one unicode hyphen still matches itself");

console.log("\n5. Missing dates do not split a job");

assert.equal(
  plainlySame(
    { company: "Preact", title: "Founding ML Engineer" },
    { company: "Preact", title: "Founding ML Engineer", start_date: "2012-11", end_date: "2016-10" },
  ),
  true,
);
ok("a document that does not say when is not evidence of a second job");

console.log("\n6. Which way it fails");

/*
  Without a credential there is no reading, so only the plain matches are
  made. That imports a duplicate rather than losing a job, which is the right
  way round: a duplicate is a row on a page and one click; a lost job is
  invisible.
*/
const found = await duplicates(
  [
    { company: "University of Washington (Genome Sciences)", title: "Research Assistant", start_date: "January 2005", end_date: "September 2010" },
    { company: "Facebook", title: "Engineer", start_date: "2018-01", end_date: "2020-01" },
  ],
  [
    { id: 11, company: "University of Washington", title: "Research Assistant", start_date: "2005-01", end_date: "2010-09" },
    { id: 20, company: "Meta", title: "Engineer", start_date: "2018-01", end_date: "2020-01" },
  ],
);

assert.equal(found.get(0), 11);
ok("the plain duplicate is caught with no call made");

assert.equal(found.has(1), false);
ok("and the one that needs reading is imported rather than guessed at");

assert.deepEqual([...(await duplicates([], []))], []);
assert.deepEqual([...(await duplicates([{ company: "A", title: "B" }], []))], []);
ok("an empty profile has nothing to repeat");

console.log(`\n${passed} passed, 0 failed`);
