import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import {
  InputAcceptanceLedger,
  IngressQueueFullError,
  computePayloadHash,
} from "../src/host/ingress.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";

function makeInput(inputId: string, text = "hello"): Record<string, unknown> {
  return {
    inputId,
    triggerOrigin: directUserRequest(),
    blocks: [
      {
        blockId: `block-${inputId}`,
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text },
        contentHash: "",
      },
    ],
  };
}

function openLedger(
  dataRoot: string,
  config = defaultAgentConfig(),
  instanceEpoch = 1,
): InputAcceptanceLedger {
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  return new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, instanceEpoch);
}

test("ingress accepts, deduplicates and marks session_committed", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-basic-"));
  const ledger = openLedger(dataRoot);
  try {
    const input = makeInput("in-0001");
    const first = ledger.accept(input, "in-0001");
    assert.equal(first.outcome, "accepted");
    assert.equal(first.record.state, "accepted");

    // Same identity + same payload: returns the existing result.
    const duplicate = ledger.accept(input, "in-0001");
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(duplicate.record.inputId, "in-0001");

    // Same identity + different payload: typed conflict.
    const conflict = ledger.accept(makeInput("in-0001", "different"), "in-0001");
    assert.equal(conflict.outcome, "idempotency_conflict");
    assert.equal(conflict.record.payloadHash, computePayloadHash(input));

    // Mark committed; a later duplicate returns the committed record without
    // re-prompting (session_committed inputs are never re-delivered).
    const committed = ledger.markSessionCommitted(
      "in-0001",
      1,
      "iris-runtime-2026-08-01-1",
      "entry-1",
    );
    assert.equal(committed.state, "session_committed");
    const after = ledger.accept(input, "in-0001");
    assert.equal(after.outcome, "duplicate");
    assert.equal(after.record.state, "session_committed");
    assert.equal(ledger.recoverUncommitted().length, 0);
  } finally {
    ledger.close();
  }
});

test("ingress FIFO queue is bounded and rejects overflow", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-queue-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
  initializeDataRoot(dataRoot, defaultAgentConfig());
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 2, 1);
  try {
    ledger.accept(makeInput("q-0001"), "q-0001");
    ledger.accept(makeInput("q-0002"), "q-0002");
    assert.throws(() => ledger.accept(makeInput("q-0003"), "q-0003"), IngressQueueFullError);
    // FIFO order on dequeue.
    assert.equal(ledger.dequeue()?.inputId, "q-0001");
    assert.equal(ledger.dequeue()?.inputId, "q-0002");
    assert.equal(ledger.dequeue(), undefined);
    // Space freed: a new accept succeeds.
    const ok = ledger.accept(makeInput("q-0003"), "q-0003");
    assert.equal(ok.outcome, "accepted");
  } finally {
    ledger.close();
  }
});

test("ingress loadEnvelope round-trips the durable normalized envelope", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-envelope-"));
  const ledger = openLedger(dataRoot);
  try {
    const input = makeInput("env-0001", "payload text");
    ledger.accept(input, "env-0001");
    const envelope = ledger.loadEnvelope("env-0001", 1) as AgentInput;
    assert.equal(envelope.inputId, "env-0001");
    assert.equal((envelope.blocks[0]?.content as { text: string }).text, "payload text");
  } finally {
    ledger.close();
  }
});

test("ingress recovery returns only accepted-and-uncommitted inputs", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-recover-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
  initializeDataRoot(dataRoot, defaultAgentConfig());
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    ledger.accept(makeInput("r-0001"), "r-0001"); // stays accepted
    ledger.accept(makeInput("r-0002"), "r-0002");
    ledger.markSessionCommitted("r-0002", 1, "session-x", "entry-x");
    ledger.accept(makeInput("r-0003"), "r-0003");
    ledger.markRejected("r-0003", 1, "validation_failed"); // rejected => ignored

    const pending = ledger.recoverUncommitted();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.inputId, "r-0001");
    // The recovered entry is re-enqueued; dequeue returns it once.
    assert.equal(ledger.dequeue()?.inputId, "r-0001");
    assert.equal(ledger.dequeue(), undefined);
  } finally {
    ledger.close();
  }
});

test("ingress crash window 1: no record before accept commit (retry re-accepts)", () => {
  // Crash BEFORE the accepted record commits: no durable trace, so the client
  // retry with the same identity simply accepts again — no duplicate logic.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-cw1-"));
  const ledger = openLedger(dataRoot);
  try {
    const first = ledger.accept(makeInput("cw-0001"), "cw-0001");
    assert.equal(first.outcome, "accepted");
    const retry = ledger.accept(makeInput("cw-0001"), "cw-0001");
    assert.equal(retry.outcome, "duplicate");
    assert.equal(retry.record.state, "accepted");
  } finally {
    ledger.close();
  }
});

test("ingress crash window 2/3/4: accepted-but-uncommitted survives restart and re-enters queue", () => {
  // Crash AFTER the accepted record commit but BEFORE session_committed (the
  // accepted-after, pre-Pi-append / mid-pair windows): the record is durable
  // and recovery re-enters it through the normal single-writer path. The
  // session_committed transition is only set after the pair is verified, so
  // no accepted record is ever lost and none is double-prompted.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-cw234-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
  initializeDataRoot(dataRoot, defaultAgentConfig());

  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("cw-0001"), "cw-0001");
  ledger.close();

  // Restart (new ledger over the same DB) simulates the process crash.
  const restarted = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    const pending = restarted.recoverUncommitted();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.inputId, "cw-0001");
    const envelope = restarted.loadEnvelope("cw-0001", 1) as AgentInput;
    assert.equal(envelope.inputId, "cw-0001");
  } finally {
    restarted.close();
  }
});

test("ingress crash window 5: session_committed survives restart and never re-prompts", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-cw5-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
  initializeDataRoot(dataRoot, defaultAgentConfig());

  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("cw-0001"), "cw-0001");
  ledger.markSessionCommitted("cw-0001", 1, "iris-runtime-2026-08-01-1", "entry-1");
  ledger.close();

  const restarted = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    // Committed inputs are never returned by recovery and never re-prompted.
    assert.equal(restarted.recoverUncommitted().length, 0);
    const record = restarted.getRecord("cw-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(record.runtimeSessionId, "iris-runtime-2026-08-01-1");
    assert.equal(record.userEntryId, "entry-1");
  } finally {
    restarted.close();
  }
});

test("ingress markRejected records the typed rejection code", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-reject-"));
  const ledger = openLedger(dataRoot);
  try {
    ledger.accept(makeInput("rj-0001"), "rj-0001");
    const record = ledger.markRejected("rj-0001", 1, "validation_failed");
    assert.equal(record.state, "rejected");
    assert.equal(record.rejectionCode, "validation_failed");
  } finally {
    ledger.close();
  }
});

test("ingress blob is fsynced before the accepted record commit", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-ingress-blob-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());
  initializeDataRoot(dataRoot, defaultAgentConfig());
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    ledger.accept(makeInput("blob-0001"), "blob-0001");
    const record = ledger.getRecord("blob-0001", 1);
    assert.ok(record?.normalizedInputRef !== undefined);
    const blobPath = join(paths.blobsIngress, record.normalizedInputRef.uri);
    assert.ok(existsSync(blobPath), "normalized envelope blob must exist on disk");
    const parsed = JSON.parse(readFileSync(blobPath, "utf8")) as { inputId: string };
    assert.equal(parsed.inputId, "blob-0001");
  } finally {
    ledger.close();
  }
});
