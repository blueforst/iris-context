import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "src", "db", "migrations", "historian");

test("iris_agent#64: migration 0008 applies from a clean root and adds receipt binding columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "m64-"));
  try {
    const dbPath = join(dir, "h.db");
    const result = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.ok(result.appliedVersions.includes("0008_receipt_binding"), "0008 applied");
    const db = new DatabaseSync(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(publications)")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const col of [
      "delivered_receipt_id",
      "delivered_receipt_schema_version",
      "delivered_receipt_publication_id",
      "delivered_canonical_payload_hash",
      "delivered_contract_version",
      "delivered_duplicate_replay",
    ]) {
      assert.ok(cols.includes(col), `publications.${col} exists`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
