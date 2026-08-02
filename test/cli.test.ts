import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "..");
const distBin = join(repoRoot, "dist", "bin.js");

interface CliRunOutput {
  status: string;
  settled: boolean;
  provider: string;
  epochId: string;
  runtimeSessionId: string;
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  entryCount: number;
}

interface CliServeOutput {
  status: string;
  lockAcquired: boolean;
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [distBin, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

test("iris bin is built and executable", () => {
  assert.ok(existsSync(distBin), "dist/bin.js must exist (run npm run build first)");
});

test("iris run executes a real subprocess vertical slice to settled", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-run-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(
    inputFile,
    JSON.stringify({
      inputId: "cli-input-0001",
      triggerOrigin: {
        schemaVersion: 1,
        principalKind: "user",
        authority: "user_request",
        trust: "trusted",
      },
      blocks: [
        {
          blockId: "cli-block-0001",
          sourceOrigin: {
            schemaVersion: 1,
            principalKind: "user",
            authority: "user_request",
            trust: "trusted",
          },
          content: { mode: "inline_text", text: "hello iris, run the read tool" },
          contentHash: "",
        },
      ],
      interaction: { interactionId: "cli-interaction-0001" },
    }),
    "utf8",
  );

  const { stdout, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 0, `cli exited ${exitCode}: ${stdout}`);
  const output = JSON.parse(stdout) as CliRunOutput;
  assert.equal(output.status, "ok");
  assert.equal(output.settled, true);
  assert.equal(output.provider, "mock");
  assert.ok(output.epochId.startsWith("iris-runtime-"));
  assert.ok(output.runtimeSessionId.startsWith("iris-runtime-"));
  assert.ok(output.toolCalls.length >= 1, "vertical slice must execute the read tool");
  assert.ok(output.entryCount >= 3);
});

test("iris run rejects an input with a mismatched content hash", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-badhash-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(
    inputFile,
    JSON.stringify({
      inputId: "cli-input-bad",
      blocks: [
        {
          blockId: "block-1",
          sourceOrigin: {
            schemaVersion: 1,
            principalKind: "user",
            authority: "user_request",
            trust: "trusted",
          },
          content: { mode: "inline_text", text: "hello" },
          contentHash: "deadbeef",
        },
      ],
    }),
    "utf8",
  );

  const { stderr, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /contentHash does not match/i);
});

test("iris run rejects malformed input structure", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-badshape-"));
  const inputFile = join(dataRoot, "input.json");
  writeFileSync(inputFile, JSON.stringify({ inputId: "x", blocks: [] }), "utf8");

  const { stderr, exitCode } = runCli([
    "run",
    "--data-root",
    dataRoot,
    "--input-file",
    inputFile,
    "--provider",
    "mock",
  ]);

  assert.equal(exitCode, 1);
  assert.match(stderr, /non-empty blocks/i);
});

test("iris serve bootstraps the data root in a subprocess", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-cli-serve-"));
  const { stdout, exitCode } = runCli(["serve", "--data-root", dataRoot]);

  assert.equal(exitCode, 0);
  const output = JSON.parse(stdout) as CliServeOutput;
  assert.equal(output.status, "bootstrap");
  assert.equal(output.lockAcquired, true);
  assert.ok(existsSync(join(dataRoot, "runtime-epochs.db")));
});
