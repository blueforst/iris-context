import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Migration SQL files are not compiled by tsc; mirror them into dist so the
// built ContextStore can run migrations from the compiled layout
// (dist/src/db/migrations/context).
//
// The canonical runtime_events ledger lives IN context.db (migration 0011,
// RuntimeEvent + ContextMessageUnit committed in the same transaction with the
// same contextSeq); the legacy separate runtime-events.db is superseded.
const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "src", "db", "migrations");
const target = join(root, "dist", "src", "db", "migrations");
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`copied ${source} -> ${target}`);
