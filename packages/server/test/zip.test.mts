/*
  Reading a zip, and reading only the part of it that was asked for.

  The archive LinkedIn emails is mostly not a career history. It carries
  messages, invitations, ad preferences and every reaction the person has ever
  left, and none of that belongs in a prompt — so the test that matters most
  here is the one proving a private file in the same archive is not read.

  The archives are built by the system `zip`, so this runs against real
  deflated entries rather than bytes written to match the parser.

  Run: npx tsx test/zip.test.mts
*/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isZip, list, readText } from "../src/zip.js";
import { readSource } from "../src/onboard.js";

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));

/* An archive shaped like the real one: the files nested a folder deep. */
const inside = path.join(scratch, "Basic_LinkedInDataExport");
fs.mkdirSync(inside);
fs.writeFileSync(
  path.join(inside, "Profile.csv"),
  "First Name,Last Name,Headline\nPriya,Raghavan,Senior Platform Engineer\n",
);
fs.writeFileSync(
  path.join(inside, "Positions.csv"),
  "Company Name,Title,Started On,Finished On\nMonzo,Senior Platform Engineer,Mar 2019,\n",
);
fs.writeFileSync(
  path.join(inside, "Education.csv"),
  "School Name,Degree Name\nUniversity of Bristol,BSc Computer Science\n",
);
/* The thing that must not be read, in the same archive. */
fs.writeFileSync(
  path.join(inside, "messages.csv"),
  "FROM,TO,CONTENT\nsomeone,them,something private\n",
);
/* Large enough to be deflated rather than stored, so both paths are covered. */
fs.writeFileSync(path.join(inside, "Skills.csv"), `Name\n${"Kubernetes\n".repeat(400)}`);

const archive = path.join(scratch, "export.zip");
execFileSync("zip", ["-q", "-r", archive, "Basic_LinkedInDataExport"], { cwd: scratch });
const bytes = fs.readFileSync(archive);

console.log("\n1. Telling a zip from anything else");

assert.equal(isZip(bytes), true);
ok("a real archive is recognised");

assert.equal(isZip(Buffer.from("%PDF-1.7 and then some")), false);
assert.equal(isZip(Buffer.alloc(0)), false);
assert.equal(isZip(Buffer.from("PK")), false);
ok("a PDF, nothing at all, and two hopeful bytes are not");

console.log("\n2. What is in it, without decompressing it");

const entries = list(bytes).map((entry) => entry.name);
assert.ok(entries.some((name) => name.endsWith("Positions.csv")));
assert.ok(entries.some((name) => name.endsWith("messages.csv")));
assert.ok(entries.some((name) => name.startsWith("Basic_LinkedInDataExport/")));
ok("every member is listed, under the folder it sits in");

console.log("\n3. Only the files that were asked for");

/*
  The point of naming the files rather than reading the archive. Somebody's
  private messages are in the same zip as their job titles, and reading the
  whole thing would mean sending their correspondence to a model to find out
  where they went to school.
*/
const career = readText(bytes, (name) =>
  /^(Profile|Positions|Education|Skills)\.csv$/i.test(name.split("/").pop() ?? ""),
);
assert.equal(career.length, 4);
assert.equal(career.some((file) => /messages/i.test(file.name)), false);
ok("the four named files are read and the private one is not");

assert.match(career.find((file) => /Positions/.test(file.name))!.text, /Monzo,Senior Platform/);
ok("a deflated member comes back as its own text");

assert.match(career.find((file) => /Skills/.test(file.name))!.text, /Kubernetes/);
assert.equal(
  career.find((file) => /Skills/.test(file.name))!.text.split("\n").length,
  402,
  "a member large enough to be compressed came back short",
);
ok("and so does a large one, in full");

console.log("\n4. A budget, because an archive says how big it is and may be lying");

const little = readText(bytes, () => true, 100);
assert.ok(little.length < 5, "the cap did not stop anything");
ok("a cap on what will be decompressed is honoured");

console.log("\n5. Damage is reported, not guessed at");

assert.throws(() => list(Buffer.from("not an archive at all")), /Not a zip file/);
ok("something that is not an archive says so");

const truncated = bytes.subarray(0, bytes.length - 40);
assert.throws(() => list(truncated), /Not a zip file|index is damaged/);
ok("and one with its index cut off does too, rather than returning half a list");

console.log("\n6. The export is read as it arrives");

const read = readSource(archive);
assert.equal(read.source, "linkedin");
assert.match(read.text, /--- .*Positions\.csv/);
assert.match(read.text, /University of Bristol/);
assert.equal(/something private/.test(read.text), false);
ok("no unzipping, and nothing private in what would go to the model");

fs.writeFileSync(path.join(scratch, "notes.zip"), "PK and then lies");
assert.throws(() => readSource(path.join(scratch, "notes.zip")), /named \.zip but is not one/);
ok("a file named .zip that is not one says exactly that");

/* An archive of the wrong thing: readable, but not a career. */
fs.mkdirSync(path.join(scratch, "holiday"));
fs.writeFileSync(path.join(scratch, "holiday", "receipts.csv"), "a,b\n1,2\n");
const wrong = path.join(scratch, "holiday.zip");
execFileSync("zip", ["-q", "-r", wrong, "holiday"], { cwd: scratch });
assert.throws(() => readSource(wrong), /No LinkedIn career files[\s\S]*receipts\.csv/);
ok("and one with none of the right files names what it found instead");

console.log(`\n${passed} passed, 0 failed`);
