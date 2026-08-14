#!/usr/bin/env node
/**
 * Codegen freshness gate: verifies contracts/generated/ is up-to-date with
 * contracts/source/schemas.json.
 *
 * Runs codegen and checks whether any files changed. The ONLY tolerated
 * difference is the `generatedAt` date marker in contracts/generated/registry.json
 * (codegen writes today's date; equivalent rebuilds on later days must not be
 * reported stale). Any other drift — a source change without regeneration, a
 * hand-edited generated file, a semantic change — fails closed.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REGISTRY = path.join(REPO_ROOT, "contracts/generated/registry.json");

try {
  execSync("node scripts/codegen.mjs", { cwd: REPO_ROOT, stdio: "pipe" });

  // Diff the whole generated tree; the date marker in registry.json is the
  // only allowed delta.
  let diffOut;
  try {
    diffOut = execSync("git diff -- contracts/generated/", {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    diffOut = (e.stdout ?? "") + (e.stderr ?? "");
  }

  if (diffOut.trim() === "") {
    console.log("Generated artifacts are fresh");
    process.exit(0);
  }

  // Tolerate ONLY a generatedAt line change in registry.json.
  const tolerated = /^[-+]\s*"generatedAt": "[^"]*",?$/m;
  const lines = diffOut.split("\n");
  const allTolerated = lines.every(
    (line) =>
      line === "" ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      tolerated.test(line) ||
      line.startsWith(" "),
  );
  const onlyRegistry = diffOut.includes("diff --git a/contracts/generated/registry.json");
  const touchedOtherFiles = /diff --git a\/contracts\/generated\/(?!registry\.json)/.test(diffOut);

  if (allTolerated && onlyRegistry && !touchedOtherFiles) {
    // Only the date marker changed: restore the committed registry.json so the
    // working tree stays clean, and report fresh.
    execSync("git checkout -- contracts/generated/registry.json", {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    console.log("Generated artifacts are fresh (only generatedAt date marker differs)");
    process.exit(0);
  }

  console.error("Generated artifacts are STALE. Run: node scripts/codegen.mjs");
  console.error(diffOut.slice(0, 2000));
  process.exit(1);
} catch (error) {
  console.error("Codegen freshness check failed:", error.message);
  process.exit(1);
}
