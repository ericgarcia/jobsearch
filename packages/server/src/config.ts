import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Load .env from the repo root. npm runs a workspace script with the cwd set to
 * that workspace, not the repo root, so look upward rather than only in cwd.
 */
function loadEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // An unreadable or malformed .env must not stop the server.
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadEnv();

/**
 * Personal data lives outside the repo. The repo is public; the database is not.
 */
export const DATA_DIR =
  process.env.JOBSEARCH_DATA_DIR ?? path.join(os.homedir(), ".jobsearch");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "jobsearch.db");

/**
 * Which database to use, as a libSQL URL.
 *
 * The default is the same local file this app has always written. Point
 * JOBSEARCH_DB_URL at a `libsql://` host to use a database somewhere else,
 * which is how a hosted copy reaches the one belonging to its user. Nothing
 * in the code above the driver knows the difference.
 */
export const DB_URL = process.env.JOBSEARCH_DB_URL ?? `file:${DB_PATH}`;
export const DB_TOKEN = process.env.JOBSEARCH_DB_TOKEN;
export const PORT = Number(process.env.PORT ?? 5179);

/*
  Split Pilot's extension id. An unpacked extension is identified by the path
  it was loaded from, so this differs on every machine. The default is the id
  on the machine this was built on; set JOBSEARCH_SPLIT_EXTENSION_ID to yours,
  which chrome://extensions shows under the extension's name.
*/
/**
 * Where the web app is served. The left pane of the split view.
 *
 * Installed, this server serves the app too, so its own port is the answer.
 * In development Vite serves it on 5173 and this is wrong, which is why the
 * dev script sets JOBSEARCH_APP_URL. Nothing breaks when it is: the split
 * looks for a tab on any localhost port and only falls back to this when it
 * has to open one itself.
 */
export const APP_URL = process.env.JOBSEARCH_APP_URL ?? `http://localhost:${PORT}/`;

export const SPLIT_EXTENSION_ID =
  process.env.JOBSEARCH_SPLIT_EXTENSION_ID ?? "nckkffcpdbfdbpjnkkkdbjagdmoepdee";
export const MODEL = process.env.JOBSEARCH_MODEL ?? "claude-opus-5-5";

