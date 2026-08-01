/**
 * Runs every crash-window boundary sequentially. Exits non-zero if any
 * boundary fails its recovery assertions. Cross-platform (no shell loops).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const harnessPath = join(here, "crash-harness.ts");
const boundaries = [
  "before_any_write",
  "after_user_append",
  "after_companion_append",
  "after_epoch_created",
  "after_settled",
  "after_tool_result_commit",
];

function runBoundary(boundary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", harnessPath, "--boundary", boundary],
      { stdio: "inherit" },
    );
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`crash boundary ${boundary} failed with exit code ${code}`));
      }
    });
    child.once("error", reject);
  });
}

const failures: string[] = [];
for (const boundary of boundaries) {
  process.stdout.write(`[crash:check] running ${boundary}...\n`);
  try {
    await runBoundary(boundary);
    process.stdout.write(`[crash:check] ${boundary}: ok\n`);
  } catch (error) {
    failures.push(`${boundary}: ${(error as Error).message}`);
  }
}

if (failures.length > 0) {
  console.error("CRASH:CHECK FAILURES:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log(`[crash:check] all ${boundaries.length} boundaries passed`);
