/*
  The SQL location rule must agree with the JavaScript one it replaced.

  locationMatches ran inside SQLite as a registered function. libSQL cannot do
  that, so the same decision is now made by stored tokens and a LIKE. The two
  have to agree on every input, or postings quietly stop matching a place
  someone searches for — the kind of fault nobody reports, because an empty
  result looks like an empty result.

  So: run both over the location strings boards actually write, and compare.
*/
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { locationClause, locationMatches, locationTokens } from "../src/location.js";

const LOCATIONS = [
  "New York, NY",
  "San Francisco, CA | New York City, NY | Seattle, WA",
  "NY, SF, Chicago, Remote",
  "US-Remote; US-Chicago; US-Atlanta; CA-Toronto; CA-Remote",
  "New York City Metropolitan Area",
  "Dublin or London",
  "Germany",
  "Remote (US)",
  "London, UK",
  "Austin, TX / Remote",
  "Greater Boston Area",
  "Brooklyn, New York",
  null,
  "",
];

const NEEDLES = [
  "ny", "sf", "la", "dc", "wa", "tx", "uk", "ca", "us",
  "new york", "san francisco", "seattle", "chicago", "london", "dublin",
  "remote", "boston", "brooklyn", "austin", "germany", "toronto", "atlanta",
];

const client = createClient({ url: ":memory:" });

await client.execute(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, location TEXT, location_tokens TEXT)`);
for (const [index, location] of LOCATIONS.entries()) {
  await client.execute({
    sql: `INSERT INTO jobs (id, location, location_tokens) VALUES (?, ?, ?)`,
    args: [index, location, locationTokens(location)],
  });
}

let checked = 0;
const disagreements: string[] = [];

for (const needle of NEEDLES) {
  const clause = locationClause(needle);
  assert.ok(clause, `no clause for ${needle}`);

  const rows = await client.execute({
    sql: `SELECT id FROM jobs j WHERE ${clause.sql}`,
    args: [clause.param],
  });
  const fromSql = new Set(rows.rows.map((row) => Number(row.id)));

  for (const [index, location] of LOCATIONS.entries()) {
    const fromJs = locationMatches(location, needle);
    checked += 1;
    if (fromJs !== fromSql.has(index)) {
      disagreements.push(
        `  "${needle}" vs ${JSON.stringify(location)}: js=${fromJs} sql=${fromSql.has(index)}`,
      );
    }
  }
}

console.log(`\nSQL location rule matches the JavaScript one`);
if (disagreements.length > 0) {
  console.log(`  ${disagreements.length} of ${checked} disagree:`);
  for (const line of disagreements) console.log(line);
} else {
  console.log(`  ok   all ${checked} comparisons agree`);
}

assert.equal(disagreements.length, 0, "the SQL rule must match the JavaScript rule");
console.log(`\n${checked} passed, 0 failed`);
