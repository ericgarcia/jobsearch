/*
  Folders on this computer the assistant may read.

  Everything here is about the boundary, because the boundary is the whole
  feature. A person who allows one folder has allowed that folder: not its
  parent, not a sibling whose name starts with the same letters, not what a
  symbolic link inside it points at, and not the hidden files they were not
  thinking about when they said yes.

  So these are mostly attempts to get out of a granted folder, each of which
  would be a quiet way to read somebody's keys. They are written against the
  real filesystem rather than a mock: the thing being tested is what the
  operating system does with "..", with links and with case, and a mock
  would only test what I believe about that.

  Run: JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx test/files.test.mts
*/

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrate, run } from "../src/db/client.js";
import {
  answerRequest,
  askForFolder,
  grants,
  listFolder,
  pendingRequest,
  readText,
  revokeGrant,
} from "../src/files.js";

await migrate();

let passed = 0;
const ok = (what: string) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

/*
  A small world: one folder that will be allowed, one next to it that will
  not, and the traps inside the allowed one.
*/
/*
  Resolved, because the check resolves: on a Mac the temporary directory is
  reached through /var, which is a link to /private/var, and a test that
  held the unresolved name would be testing the link rather than the rule.
*/
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobsearch-files-")));
const open = path.join(root, "work");
const shut = path.join(root, "private");
await mkdir(open, { recursive: true });
await mkdir(shut, { recursive: true });
await mkdir(path.join(open, "notes"), { recursive: true });
await mkdir(path.join(open, ".git"), { recursive: true });

await writeFile(path.join(open, "resume.md"), "# Eric Garcia\n\nML engineer.\n");
await writeFile(path.join(open, "notes", "ideas.txt"), "Ask about the Spotify team.\n");
await writeFile(path.join(open, ".env"), "ANTHROPIC_API_KEY=sk-not-a-real-key\n");
await writeFile(path.join(open, ".git", "config"), "[remote]\n");
await writeFile(path.join(open, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
await writeFile(path.join(open, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
await writeFile(path.join(shut, "secrets.txt"), "the other folder\n");
await symlink(shut, path.join(open, "out"));
await symlink(path.join(shut, "secrets.txt"), path.join(open, "out.txt"));

/* A sibling whose name starts with the allowed one, which a string compare would let through. */
const lookalike = `${open}-archive`;
await mkdir(lookalike, { recursive: true });
await writeFile(path.join(lookalike, "old.txt"), "not in the grant\n");

console.log("\n1. Nothing is readable until they say so");

await assert.rejects(() => readText(path.join(open, "resume.md")), /ask_for_folder/);
await assert.rejects(() => listFolder(open), /ask_for_folder/);
ok("a file in a folder nobody allowed is refused, and the refusal says how to ask");

assert.deepEqual(await grants(), []);
ok("and no grant exists to have made it readable");

console.log("\n2. Asking is not granting");

const asked = await askForFolder(open, "Your resume is in here and I want to read it.");
assert.ok("asked" in asked);
assert.equal((await pendingRequest())?.path, open);
await assert.rejects(() => readText(path.join(open, "resume.md")), /ask_for_folder/);
ok("a request waiting changes nothing: the folder is still not readable");

await answerRequest(false);
assert.equal(await pendingRequest(), null);
assert.deepEqual(await grants(), []);
await assert.rejects(() => readText(path.join(open, "resume.md")), /ask_for_folder/);
ok("and saying no leaves it that way");

console.log("\n3. Their yes is what grants it");

await askForFolder(open, "Your resume is in here and I want to read it.");
const { granted } = await answerRequest(true);
assert.equal(granted?.path, open);

const resume = await readText(path.join(open, "resume.md"));
assert.match(resume.text, /ML engineer/);
ok("the file reads once they have allowed the folder");

const inside = await readText(path.join(open, "notes", "ideas.txt"));
assert.match(inside.text, /Spotify/);
ok("and so does one in a folder inside it");

const listing = await listFolder(open);
assert.deepEqual(
  listing.entries.map((one) => one.name).sort(),
  ["notes", "photo.png", "resume.md", "server.pem"].sort(),
);
ok("a listing shows what is there");

assert.match(listing.note ?? "", /2 links lead outside/);
ok("and leaves out the links that lead out of the folder, saying how many");

console.log("\n4. The ways out of a granted folder");

await assert.rejects(() => readText(path.join(shut, "secrets.txt")), /not in a folder/);
ok("a folder next to the granted one is not readable");

await assert.rejects(
  () => readText(path.join(open, "..", "private", "secrets.txt")),
  /not in a folder/,
);
ok('and nor is the same place reached through ".."');

await assert.rejects(() => readText(path.join(lookalike, "old.txt")), /not in a folder/);
ok("nor a sibling whose name begins with the granted one, which a string compare would allow");

await assert.rejects(() => readText(path.join(open, "out.txt")), /not in a folder/);
ok("nor a link inside the grant pointing at a file outside it");

await assert.rejects(() => listFolder(path.join(open, "out")), /not in a folder/);
ok("nor a link inside the grant pointing at a folder outside it");

await assert.rejects(() => readText(path.join(root)), /not in a folder/);
ok("and the parent of the granted folder is not covered by granting the child");

console.log("\n5. Hidden things, inside the grant");

await assert.rejects(() => readText(path.join(open, ".env")), /hidden/);
ok("a dot-file inside an allowed folder is still refused");

await assert.rejects(() => readText(path.join(open, ".git", "config")), /hidden/);
ok("and so is a file in a dot-folder, however ordinary its own name");

assert.equal(
  listing.entries.some((one) => one.name.startsWith(".")),
  false,
);
assert.match(listing.note ?? "", /hidden/);
ok("a listing leaves them out and says how many it left out");

await assert.rejects(() => readText(path.join(open, "server.pem")), /secret/);
ok("a key is refused by name even without a leading dot");

console.log("\n6. What a read gives back");

await assert.rejects(() => readText(path.join(open, "photo.png")), /not text/);
ok("a binary file is refused rather than handed over as mojibake");

await assert.rejects(() => readText(open), /is a folder/);
await assert.rejects(() => listFolder(path.join(open, "resume.md")), /is a file/);
ok("and each tool says which of the two the other one is for");

await assert.rejects(() => readText("resume.md"), /absolute path/);
ok("a relative path is refused rather than resolved against whatever the cwd is");

console.log("\n7. Theirs to take back");

const live = (await grants())[0]!;
assert.equal((await revokeGrant(live.id)).revoked, true);
await assert.rejects(() => readText(path.join(open, "resume.md")), /ask_for_folder/);
ok("taking a grant back stops the reads at once");

assert.equal((await revokeGrant(live.id)).revoked, false);
ok("and taking it back twice is not an error");

console.log("\n8. One request at a time");

await run(`DELETE FROM pending_grant`);
await askForFolder(open, "First.");
await askForFolder(shut, "Second.");
assert.equal((await pendingRequest())?.path, shut);
assert.equal((await grants()).length, 0);
ok("a second request replaces the first rather than queueing, and neither grants anything");

await assert.rejects(
  () => askForFolder(path.join(open, "resume.md"), "This file."),
  /Ask for the folder/,
);
await assert.rejects(() => askForFolder(path.join(root, "nowhere"), "Missing."), /nothing at/);
await assert.rejects(() => askForFolder(open, "   "), /Say why/);
ok("and a request for a file, for nothing, or with no reason is refused");

console.log(`\n${passed} passed, 0 failed`);
