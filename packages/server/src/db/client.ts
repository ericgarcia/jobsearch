import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH } from "../config.js";
import { locationMatches } from "../location.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(DB_PATH);

// The database holds a credential. Keep it readable only by this user.
try {
  fs.chmodSync(DB_PATH, 0o600);
} catch {
  // A filesystem that does not support chmod must not stop the server.
}
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/** Apply the schema. Every statement is CREATE ... IF NOT EXISTS, so this is idempotent. */
export function migrate(): void {
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  addMissingColumns();
  // search_criteria was created in the first version and never used; interests
  // replaces it. Nothing ever wrote to it, so there is nothing to carry over.
  db.exec("DROP TABLE IF EXISTS search_criteria");
}

/**
 * schema.sql only creates tables that do not exist, so a column added to an
 * existing table needs its own step. Each entry is applied once and ignored
 * afterwards.
 */
function addMissingColumns(): void {
  const additions: [table: string, column: string, definition: string][] = [
    ["resumes", "warnings", "TEXT NOT NULL DEFAULT '[]'"],
    ["job_assessments", "model", "TEXT"],
  ];

  for (const [table, column, definition] of additions) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length > 0 && !columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

// Location matching is too irregular for LIKE, so it runs in JavaScript and is
// registered here as a SQL function (see location.ts).
db.function("loc_matches", { deterministic: true }, (location, needle) =>
  locationMatches(location as string | null, String(needle)) ? 1 : 0,
);

// Run at import time. repo.ts prepares statements in its module body, and ESM
// evaluates that body before index.ts runs, so the tables must already exist.
migrate();
