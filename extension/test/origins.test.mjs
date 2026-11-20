/*
  Who the extension will answer.

  `externally_connectable` is the whole of the access control on the
  extension's control surface. A page on a listed origin can pair and unpair
  the person's tabs, open URLs in their right pane, and call set-token — and
  that token is what Playwright presents to drive the browser through an
  extension holding the debugger permission on every URL. A page on an
  unlisted origin is not even given `chrome.runtime`.

  It used to list every port on localhost, which on a developer's machine is
  any project they happen to be serving.

  Two things are checked. That the list stays narrow, because widening it is
  the kind of edit that looks like a fix for a broken port and is actually
  the door opening again. And that the app's copy of the list matches the
  manifest's, because a page outside the list cannot tell a missing entry
  from a missing extension, and the app's copy is how it says which.

  Run: node extension/test/origins.test.mjs
*/

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ok   ${what}`);
};

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "..", "..");

const manifest = JSON.parse(await readFile(path.join(here, "..", "manifest.json"), "utf8"));
const matches = manifest.externally_connectable.matches;

console.log("\n1. The list is origins, not a sweep of them");

for (const match of matches) {
  assert.match(
    match,
    /^https?:\/\/[a-z0-9.-]+(:\d+)?\/\*$/,
    `"${match}" is not a single origin`,
  );
}
ok("every entry names one host and one port");

const loose = matches.filter((one) => /:\*/.test(one) || /^\*/.test(one) || /\/\/\*/.test(one));
assert.deepEqual(
  loose,
  [],
  `these match more than one origin, which is how any local page got in: ${loose.join(", ")}`,
);
ok("none of them is a wildcard over ports or hosts");

console.log("\n2. The app's copy says the same thing");

/*
  Read from the source rather than imported, because this is a plain node
  test and that file is TypeScript. The shape it reads is a plain array of
  string literals, which is the shape it should keep.
*/
const split = await readFile(path.join(root, "packages", "web", "src", "split.ts"), "utf8");
const declared = /export const ANSWERED_ORIGINS = \[([^\]]*)\]/.exec(split);
assert.ok(declared, "split.ts no longer exports ANSWERED_ORIGINS as a literal array");

const inApp = [...declared[1].matchAll(/"([^"]+)"/g)].map((one) => one[1]).sort();
const inManifest = matches.map((one) => one.replace(/\/\*$/, "")).sort();
assert.deepEqual(
  inApp,
  inManifest,
  "the app and the manifest disagree about which origins the extension answers",
);
ok("the app lists exactly the origins the manifest does");

console.log("\n3. The origins it answers are this app's own");

for (const origin of inManifest) {
  assert.match(
    origin,
    /^http:\/\/(localhost|127\.0\.0\.1):(5173|5174|5179)$/,
    `${origin} is not one of this app's own ports`,
  );
}
ok("and they are the ports this app is served from, in development and installed");

console.log(`\n${passed} passed, 0 failed`);
