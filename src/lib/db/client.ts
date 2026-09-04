/**
 * SQLite connection and schema bootstrap.
 *
 * One process-wide connection, opened lazily. WAL journaling so a long read
 * (a chart pulling 5,000 bars) never blocks a write.
 *
 * The schema is applied idempotently on first open: every statement is
 * CREATE ... IF NOT EXISTS, so opening an existing database is a no-op and
 * there is no migration ordering to get wrong at this size.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

let instance: Db | null = null;

function resolveDataDir(): string {
  const configured = process.env.DATA_DIR?.trim();
  const dir = configured && configured.length > 0 ? configured : path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function schemaPath(): string {
  // Resolved relative to this file so it works in dev, in `next build` output
  // and under the test runner alike.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "schema.sql"),
    path.join(process.cwd(), "src", "lib", "db", "schema.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not locate schema.sql");
}

export function getDb(): Db {
  if (instance) return instance;

  const file = path.join(resolveDataDir(), "terminal.sqlite");
  const db = new Database(file);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // NORMAL is the right trade-off under WAL: durable across process crashes,
  // and only loses the last transaction on an OS-level crash.
  db.pragma("synchronous = NORMAL");

  db.exec(fs.readFileSync(schemaPath(), "utf8"));

  instance = db;
  return db;
}

/** Close and forget the connection. Tests must call this to avoid a hung runner. */
export function closeDb(): void {
  if (!instance) return;
  try {
    instance.close();
  } finally {
    instance = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a JSON column, falling back rather than throwing on corrupt data. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}
