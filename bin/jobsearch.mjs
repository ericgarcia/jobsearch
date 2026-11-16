#!/usr/bin/env node
/*
  Start the app and open it.

  One command, because the alternative is asking someone to run two servers
  and remember which port holds the interface. Everything the app needs comes
  down with it from npm: the Claude Code executable the agent runs, the
  Playwright MCP it drives the browser with, and the built web app.

  The one thing this cannot install is Split Pilot. A Chrome extension has to
  be added by the person, from chrome://extensions, and no installer can do it
  for them — so say where it is rather than failing later with a browser that
  will not arrange itself.
*/
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT ?? 5179);
const URL_ = `http://127.0.0.1:${PORT}/`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`jobsearch — a job search you run yourself

  jobsearch              start the app and open it
  jobsearch --no-open    start it without opening a browser
  jobsearch --help       this

Environment:
  PORT                   default ${PORT}
  JOBSEARCH_DATA_DIR     where the database lives (default ~/.jobsearch)
`);
  process.exit(0);
}

/* ------------------------------------------------------- what must be there */

const web = path.join(root, "packages/web/dist/index.html");
if (!fs.existsSync(web)) {
  console.error(`The web app is not built (looked for ${web}).`);
  console.error("From a clone, run: npm run build");
  process.exit(1);
}

// Resolved rather than assumed: a missing platform binary should say so now,
// not when the first message is sent.
try {
  const manifest = require.resolve("@anthropic-ai/claude-code/package.json");
  const bin = path.join(path.dirname(manifest), require(manifest).bin.claude);
  if (!fs.existsSync(bin)) throw new Error(`not at ${bin}`);
} catch (error) {
  console.error("The Claude Code executable is missing from this install.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Reinstalling usually fixes it: npm install");
  process.exit(1);
}

/* ---------------------------------------------------------------- start it */

console.log(`jobsearch — starting on ${URL_}`);

/*
  Compiled JavaScript when there is some, TypeScript through tsx otherwise.

  An installed copy has only the compiled server: tsx is a devDependency, and
  npm does not install those for a dependency, so `npx jobsearch` would have
  died on a missing loader. A clone has src and tsx both, and running it
  straight from source there saves a build step between an edit and a restart.
*/
const compiled = path.join(root, "packages/server/dist/index.js");
const source = path.join(root, "packages/server/src/index.ts");
const args = fs.existsSync(compiled) ? [compiled] : ["--import", "tsx", source];

const server = spawn(process.execPath, args, {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PORT: String(PORT) },
});

server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
  });
}

/* ------------------------------------------------- open it once it answers */

if (!process.argv.includes("--no-open")) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  // Poll rather than guess at a delay: the first run applies migrations and
  // takes noticeably longer than later ones.
  const deadline = Date.now() + 30_000;
  const tryOpen = async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${URL_}api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          spawn(opener, [URL_], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
          console.log(`\n  Open ${URL_} if a browser did not.`);
          console.log(`  Split Pilot, for the side-by-side view, loads unpacked from:`);
          console.log(`    ${path.join(root, "extension")}\n`);
          return;
        }
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    console.error(`The server did not answer within 30s. Open ${URL_} yourself to see why.`);
  };
  void tryOpen();
}
