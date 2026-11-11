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
export const PORT = Number(process.env.PORT ?? 5179);

/*
  Split Pilot's extension id. An unpacked extension is identified by the path
  it was loaded from, so this differs on every machine. The default is the id
  on the machine this was built on; set JOBSEARCH_SPLIT_EXTENSION_ID to yours,
  which chrome://extensions shows under the extension's name.
*/
export const SPLIT_EXTENSION_ID =
  process.env.JOBSEARCH_SPLIT_EXTENSION_ID ?? "nckkffcpdbfdbpjnkkkdbjagdmoepdee";
export const MODEL = process.env.JOBSEARCH_MODEL ?? "claude-opus-5-5";

