import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type InValue, type Transaction } from "@libsql/client";
import { DB_PATH, DB_TOKEN, DB_URL } from "../config.js";
import { locationTokens } from "../location.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * One libSQL client, local or remote.
 *
 * better-sqlite3 was here, and it is a better local driver: synchronous, so
 * nothing in this codebase had to be. It cannot talk to anything but a file,
 * though, and the plan is for each person's data to live in a database they
 * own. One driver that does both means the difference between the two is a
 * URL, not a second code path nobody exercises.
 *
 * A `file:` URL keeps everything as it was. `libsql://` goes to Turso.
 */
export const client: Client = createClient(
  DB_URL.startsWith("file:") ? { url: DB_URL } : { url: DB_URL, authToken: DB_TOKEN },
);

export const isLocal = DB_URL.startsWith("file:");

/* --------------------------------------------------------------- queries */

/**
 * The transaction the current call is inside, if any.
 *
 * better-sqlite3 made this invisible: one synchronous connection, so a
 * function called inside db.transaction() was in it by definition. libSQL
 * hands out a transaction object instead, which would mean threading it
 * through every function that might be called inside one — and getting it
 * wrong silently writes outside the transaction.
 *
 * AsyncLocalStorage keeps that invisible. A query runs against the ambient
 * transaction when there is one and the client when there is not, so the fifty
 * call sites in this codebase read the same either way.
 */
const ambient = new AsyncLocalStorage<Transaction>();

function target(): Client | Transaction {
  return ambient.getStore() ?? client;
}

/*
  Positional or named, because the SQL in this codebase uses both: most
  statements take `?`, and the job upsert takes `@source` and friends because
  nine positional parameters in a row is a bug waiting to happen.
*/
type Named = Record<string, InValue>;
type Args = InValue[] | [Named];

function asArgs(args: Args): InValue[] | Named {
  const first = args[0];
  const named =
    args.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    !Array.isArray(first) &&
    !(first instanceof Date) &&
    !(first instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(first);
  return named ? (first as Named) : (args as InValue[]);
}

export async function all<T>(sql: string, ...args: Args): Promise<T[]> {
  const result = await target().execute({ sql, args: asArgs(args) });
  return result.rows as unknown as T[];
}

export async function get<T>(sql: string, ...args: Args): Promise<T | undefined> {
  const rows = await all<T>(sql, ...args);
  return rows[0];
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export async function run(sql: string, ...args: Args): Promise<RunResult> {
  const result = await target().execute({ sql, args: asArgs(args) });
  return {
    changes: result.rowsAffected,
    // libSQL reports this as a BigInt, and every caller wants a number to put
    // straight back into a query.
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

/**
 * Run work inside one transaction.
 *
 * Nested calls join the outer transaction rather than opening a second one,
 * which libSQL would refuse. That matters because the functions wrapped here
 * are also called on their own.
 */
export async function tx<T>(work: () => Promise<T>): Promise<T> {
  const existing = ambient.getStore();
  if (existing) return work();

  const transaction = await client.transaction("write");
  try {
    const result = await ambient.run(transaction, work);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback().catch(() => {
      // The transaction may already be finished; the original error is what
      // the caller needs to see.
    });
    throw error;
  }
}

/* -------------------------------------------------------------- migration */

/** Apply the schema. Every statement is CREATE ... IF NOT EXISTS, so this is idempotent. */
export async function migrate(): Promise<void> {
  if (isLocal) {
    // The database holds a credential. Keep it readable only by this user.
    // Neither applies to a database that lives on someone else's server.
    try {
      fs.chmodSync(DB_PATH, 0o600);
    } catch {
      // A filesystem that does not support chmod must not stop the server.
    }
    await client.execute("PRAGMA journal_mode = WAL");
  }
  await client.execute("PRAGMA foreign_keys = ON");

  await client.executeMultiple(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  await addMissingColumns();

  // search_criteria was created in the first version and never used; interests
  // replaces it. Nothing ever wrote to it, so there is nothing to carry over.
  await client.execute("DROP TABLE IF EXISTS search_criteria");
  // split_on_load decided whether to arrange the split view. The arrangement
  // is no longer optional, so a stored "off" would be an instruction nothing
  // reads — worse than no row at all.
  await run(`DELETE FROM settings WHERE key = 'split_on_load'`);

  await backfillLocationTokens();
}

/**
 * schema.sql only creates tables that do not exist, so a column added to an
 * existing table needs its own step. Each entry is applied once and ignored
 * afterwards.
 */
async function addMissingColumns(): Promise<void> {
  const additions: [table: string, column: string, definition: string][] = [
    ["resumes", "warnings", "TEXT NOT NULL DEFAULT '[]'"],
    ["job_assessments", "model", "TEXT"],
    ["jobs", "location_tokens", "TEXT"],
  ];

  for (const [table, column, definition] of additions) {
    const columns = await all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.length > 0 && !columns.some((c) => c.name === column)) {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

/**
 * Fill in location_tokens for rows stored before the column existed.
 *
 * Matching a place used to call into JavaScript from SQL, through a function
 * registered on the connection. libSQL cannot do that — the code would have to
 * run on Turso's server, not in this process — so the tokens a match needs are
 * computed when a job is written and matched with ordinary SQL instead. Rows
 * written before that change have none, and would silently stop matching.
 */
async function backfillLocationTokens(): Promise<void> {
  const stale = await all<{ id: number; location: string | null }>(
    `SELECT id, location FROM jobs WHERE location_tokens IS NULL`,
  );
  if (stale.length === 0) return;

  await tx(async () => {
    for (const job of stale) {
      await run(`UPDATE jobs SET location_tokens = ? WHERE id = ?`, locationTokens(job.location), job.id);
    }
  });
}
