/**
 * Codegen freshness gate (Phase A baseline).
 *
 * Phase B will introduce the single contract schema source and the codegen
 * pipeline (schema source -> generated TypeScript + JSON Schema + fixtures).
 * This gate is the future single entry point that fails when generated
 * artifacts are stale relative to the schema source.
 *
 * Phase A: there is no schema source yet, so the gate is a no-op that reports
 * the state explicitly. It must NOT pass silently once a schema source exists.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const schemaSource = resolve(root, "src/contracts/schemas");
const generated = resolve(root, "src/contracts/generated");

if (existsSync(schemaSource) && readdirSync(schemaSource).length > 0) {
  // Schema source exists: codegen must have produced fresh artifacts.
  if (!existsSync(generated) || readdirSync(generated).length === 0) {
    console.error(
      "check:codegen-freshness: schema source exists but generated artifacts are missing; run codegen",
    );
    process.exit(1);
  }
  // Freshness verification is implemented in Phase B alongside codegen.
  console.error(
    "check:codegen-freshness: schema source present — full freshness verification lands with codegen in Phase B",
  );
  process.exit(0);
}

console.log("check:codegen-freshness: no schema source yet (Phase A baseline) — OK");
