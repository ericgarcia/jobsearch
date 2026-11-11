/*
  Point the pinned Playwright MCP at Split Pilot instead of Microsoft's
  extension.

  playwright-core decides which extension to talk to with a hardcoded constant
  and offers no flag or environment variable for it:

    const playwrightExtensionId = "mmlmfjhmonkocbjadbfplnigmagldckm";

  So the only way to have one extension rather than two is to change that
  constant in the copy we install. This is why @playwright/mcp is pinned to an
  exact version: a patch against a moving dependency rots in silence, while a
  patch against a pinned one either applies or fails loudly here, at install,
  with the version printed.

  It is idempotent, and it is a no-op without JOBSEARCH_SPLIT_EXTENSION_ID —
  an id is specific to the machine that loaded the unpacked extension, so
  there is no sensible default to write into someone else's node_modules.
*/

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const UPSTREAM = "mmlmfjhmonkocbjadbfplnigmagldckm";
const ID = /^[a-p]{32}$/;

/*
  npm does not load .env, and the id lives there with everything else. Reading
  it here is the difference between the patch applying on npm install and
  quietly doing nothing, which is the failure this script exists to avoid.
*/
function fromEnvFile(key) {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === key) return match[2].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const wanted =
  process.env.JOBSEARCH_SPLIT_EXTENSION_ID ?? fromEnvFile("JOBSEARCH_SPLIT_EXTENSION_ID");

if (!wanted) {
  console.log(
    "[split-pilot] JOBSEARCH_SPLIT_EXTENSION_ID is not set; leaving Playwright pointed at " +
      "Microsoft's extension. Set it in .env to use Split Pilot as the single extension.",
  );
  process.exit(0);
}

if (!ID.test(wanted)) {
  console.error(`[split-pilot] "${wanted}" is not a Chrome extension id (32 letters a-p).`);
  process.exit(1);
}

const require = createRequire(import.meta.url);

let core;
try {
  core = path.dirname(require.resolve("playwright-core/package.json"));
} catch {
  console.error("[split-pilot] playwright-core is not installed; run npm install first.");
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(core, "package.json"), "utf8")).version;

const targets = ["lib/coreBundle.js", "lib/tools/utils/extension.js"]
  .map((file) => path.join(core, file))
  .filter((file) => fs.existsSync(file));

if (targets.length === 0) {
  console.error(`[split-pilot] playwright-core ${version} has neither file this patch expects.`);
  process.exit(1);
}

let changed = 0;
let already = 0;

for (const file of targets) {
  const before = fs.readFileSync(file, "utf8");

  if (before.includes(wanted)) {
    already += 1;
    continue;
  }
  if (!before.includes(UPSTREAM)) {
    console.error(
      `[split-pilot] ${path.relative(core, file)} in playwright-core ${version} does not ` +
        `contain the expected extension id. The patch has not been applied; this version is ` +
        `probably not the one it was written for.`,
    );
    process.exit(1);
  }

  fs.writeFileSync(file, before.split(UPSTREAM).join(wanted));
  changed += 1;
}

console.log(
  changed > 0
    ? `[split-pilot] playwright-core ${version}: pointed ${changed} file(s) at ${wanted}.`
    : `[split-pilot] playwright-core ${version}: already pointed at ${wanted} (${already} file(s)).`,
);
