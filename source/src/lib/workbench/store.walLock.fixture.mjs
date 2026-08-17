import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [databasePath, readyPath, holdMillisecondsRaw] = process.argv.slice(2);
const holdMilliseconds = Number(holdMillisecondsRaw);
if (!databasePath || !readyPath || !Number.isInteger(holdMilliseconds) || holdMilliseconds <= 0) {
  process.exit(64);
}

const waitState = new Int32Array(new SharedArrayBuffer(4));
const database = new DatabaseSync(databasePath, { timeout: 5_000 });
let exclusive = false;
try {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("CREATE TABLE IF NOT EXISTS wal_lock_probe (id INTEGER PRIMARY KEY)");
  database.exec("BEGIN EXCLUSIVE");
  exclusive = true;
  writeFileSync(readyPath, JSON.stringify({ ready: true }), { encoding: "utf8", flush: true });
  Atomics.wait(waitState, 0, 0, holdMilliseconds);
  database.exec("COMMIT");
  exclusive = false;
} finally {
  if (exclusive) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original fixture failure */ }
  }
  database.close();
}
