import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { IrisHost } from "../src/host/host.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { openOrCreateSession } from "../src/runtime/vertical-slice.js";

function makeInput(inputId: string, text = "hello iris"): AgentInput {
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

test("IrisHost: long-lived host accepts inputs, auto-consumes the FIFO, and settles", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-basic-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    const outcome = host.acceptInput(makeInput("host-0001"), "host-0001");
    assert.equal(outcome.outcome, "accepted");
    // Give the pump a moment to run the invocation to settled.
    await waitFor(() => events.includes("settled"));
    assert.equal(host.health().ready, true);
    assert.equal(host.health().coordinatorPhase, "idle");
    // The input is now durably session_committed (Pi pair verified).
    const record = host.getIngress().getRecord("host-0001", 1);
    assert.equal(record?.state, "session_committed");
    assert.ok(record.runtimeSessionId?.startsWith("iris-runtime-"));
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: second host against the same data root fails fast (lock held)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-lock-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    await assert.rejects(
      IrisHost.open({ dataRoot, config, provider: "mock" }),
      /ELOCKED|lock|already/i,
    );
  } finally {
    await host.shutdown();
  }
  // After graceful shutdown the lock is released and a new host can open.
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("IrisHost: rollover after settled creates a fresh Session and routes the next input to it", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rollover-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    // First input settles in epoch 1.
    host.acceptInput(makeInput("ro-0001"), "ro-0001");
    await waitFor(() => events.includes("settled"));

    // Request rollover; the switch happens after the settled boundary.
    host.requestRollover("test_admin_request");
    await waitFor(() => events.includes("rollover_completed"));

    const active = host.getCurrentEpoch();
    assert.notEqual(active.epochId, "iris-runtime-2026-08-01-1");
    const status = host.sessionStatus();
    assert.equal(status.epochId, active.epochId);
    assert.notEqual(status.runtimeSessionId, "iris-runtime-2026-08-01-1");

    // A queued input after the rollover enters the NEW Session's first prompt.
    host.acceptInput(makeInput("ro-0002"), "ro-0002");
    const settledCountBefore = events.filter((e) => e === "settled").length;
    await waitFor(() => events.filter((e) => e === "settled").length > settledCountBefore);
    const record = host.getIngress().getRecord("ro-0002", 1);
    assert.equal(record?.state, "session_committed");
    assert.equal(record.runtimeSessionId, active.runtimeSessionId);

    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: rollover recovery — window 2/3 (creating epoch + new session before CAS)", async () => {
  // Crash state: a 'creating' Epoch row + its new Pi Session row exist, but
  // the active CAS never happened. The real startup path must discard the
  // orphan creating Epoch/Session and keep exactly one active Epoch.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw23-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  const pending = store.beginRollover("2026-08-01T12:00:00.000Z");
  // The active Epoch's Session exists (a real product data root always has
  // one); the new Pi Session row was created (crash after create, before CAS).
  await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  await openOrCreateSession(dataRoot, config, pending.runtimeSessionId);
  store.close();

  // Real startup path: recovery cleans the orphan and opens the active Epoch.
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, active.epochId);
    assert.equal(host.sessionStatus().status, "active");
    assert.equal(host.getEpochStore().listCreating().length, 0);
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: rollover recovery — multiple active epochs is corrupt and refuses to guess", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-multiactive-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive("2026-08-01T12:00:00.000Z");
  await openOrCreateSession(dataRoot, config, "iris-runtime-2026-08-01-1");
  // Force a second active row (corrupt state) — the Host must NOT pick one
  // by creation time; it enters not-ready/corrupt.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.epochRegistryDb);
  db.prepare(
    `INSERT INTO runtime_epochs(epoch_id, runtime_session_id, local_date, ordinal_within_date, status, created_at)
     VALUES ('iris-runtime-2026-08-01-2', 'iris-runtime-2026-08-01-2', '2026-08-01', 2, 'active', '2026-08-01T12:00:01.000Z')`,
  ).run();
  db.close();

  // Real startup path: two active Epochs => not-ready/corrupt, no silent pick.
  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /corrupt: 2 active epochs/,
  );
  // The lock was released by the failed startup. Repair the corrupt state
  // (delete the duplicate active row) and re-open — the lock is re-acquirable.
  const repair = new DatabaseSync(paths.epochRegistryDb);
  repair.prepare("DELETE FROM runtime_epochs WHERE epoch_id = 'iris-runtime-2026-08-01-2'").run();
  repair.close();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await host.shutdown();
});

test("IrisHost: closed/closed_incomplete sessions never receive new inputs", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-closed-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.markClosed(active.epochId, "closed", "2026-08-01T13:00:00.000Z");
  const fresh = store.ensureActive("2026-08-01T14:00:00.000Z");
  // The fresh active Epoch's Session exists (real data root invariant).
  await openOrCreateSession(dataRoot, config, fresh.runtimeSessionId);
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    // The active Epoch is the fresh one; the closed one is archived only.
    assert.equal(host.getCurrentEpoch().epochId, fresh.epochId);
    const archives = host.archives(50);
    assert.ok(archives.some((entry) => entry.status === "closed"));
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: shutdown rejects new inputs and releases the lock", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-shutdown-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pumpPromise = host.run();
  await host.shutdown();
  await pumpPromise;
  assert.equal(host.getReady(), false);
  // Lock released: a new host can open immediately.
  const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await second.shutdown();
});

test("IrisHost: M1 — a retry while the input is in-flight is not double-prompted", async () => {
  // A client retry (same identity + same payload) during an active turn must
  // return the duplicate result WITHOUT re-enqueuing — the input is already
  // being prompted (in-flight). Only one settled per input.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-inflight-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    host.acceptInput(makeInput("inflight-0001"), "inflight-0001");
    await waitFor(() => events.includes("turn_start"));
    // While the turn is active, the client retries the same input.
    const retry = host.acceptInput(makeInput("inflight-0001"), "inflight-0001");
    assert.equal(retry.outcome, "duplicate");
    // Exactly one settled — the retry never triggered a second prompt.
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    const settledCount = events.filter((e) => e === "settled").length;
    assert.equal(settledCount, 1, `expected exactly 1 settled, got ${settledCount}`);
    assert.equal(host.getIngress().queuedCount(), 0);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: M2 — a failed invocation flips not-ready and recover() resumes the pump", async () => {
  // Simulate a provider failure by feeding an input whose frames cannot be
  // encoded (invalid content mode poisons encodeInputFrames) — the turn fails,
  // the Host flips not-ready, and recover() clears it so the pump resumes.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-failed-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    // A well-formed input that the mock provider settles normally.
    host.acceptInput(makeInput("ok-0001"), "ok-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    assert.equal(host.health().ready, true);

    // review-pass-2 #5: a poisoned envelope is rejected at the Host boundary
    // (never durably accepted, never flips the Host failed).
    const badInput = {
      inputId: "bad-0001",
      triggerOrigin: directUserRequest(),
      blocks: [
        {
          blockId: "bad-block",
          sourceOrigin: directUserRequest(),
          content: { mode: "unsupported_mode" as never, text: "x" },
          contentHash: "",
        },
      ],
    };
    assert.throws(() => host.acceptInput(badInput, "bad-0001"), /input_invalid|content mode/);
    assert.equal(host.health().ready, true, "rejected input must not flip the Host not-ready");
    assert.equal(host.getIngress().getRecord("bad-0001", 1), undefined);

    // A clean input still settles after the rejected one.
    host.acceptInput(makeInput("ok-0002"), "ok-0002");
    const settledAfter = events.filter((e) => e === "settled").length;
    await waitFor(() => events.filter((e) => e === "settled").length > settledAfter);
    assert.equal(host.health().ready, true);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: C1 — shutdown during an active turn still commits the input", async () => {
  // The worst crash-window: shutdown while an invocation is mid-turn. The
  // input must reach session_committed (the turn finishes, the ledger is only
  // closed after the pump exits) — no accepted-but-uncommitted leftover.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-c1-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    host.acceptInput(makeInput("c1-0001"), "c1-0001");
    // Wait until the turn is actually active, then shutdown mid-turn.
    await waitFor(() => events.includes("turn_start"));
    const shutdownPromise = host.shutdown();
    await shutdownPromise;
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
  // After shutdown the ledger is closed; re-open it to verify the durable
  // state (as a fresh process would after a crash/restart).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const paths = resolveDataRootPaths(dataRoot, config);
  const reopened = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  try {
    const record = reopened.getRecord("c1-0001", 1);
    assert.equal(
      record?.state,
      "session_committed",
      "C1: input must be committed, not left accepted",
    );
  } finally {
    reopened.close();
  }
});

test("IrisHost: rollover recovery — window 1 (requested, old Session not yet settled)", async () => {
  // Crash state: rollover was REQUESTED but the old Session never settled, so
  // no creating Epoch exists. Startup must keep the old active Epoch (the
  // request is not a durable switch) and serve it normally.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw1-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.requestRollover("crash_before_settled"); // pending only, no switch
  store.close();
  // The active Epoch's Session exists (real data root invariant).
  await openOrCreateSession(dataRoot, config, active.runtimeSessionId);

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, active.epochId);
    assert.equal(host.getEpochStore().countAll(), 1, "no new epoch may be created");
    assert.equal(host.sessionStatus().status, "active");
  } finally {
    await host.shutdown();
  }
});

test("IrisHost: rollover recovery — window 4/5 (CAS committed, new Session is the active Epoch)", async () => {
  // Crash state: the new Epoch row became 'active' (old -> closed) and the
  // new Pi Session row exists, but the process died before the first prompt.
  // Startup must serve the NEW active Epoch + real empty Session — not
  // resurrect the closed old one, not guess by creation time.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rw45-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  const pending = store.beginRollover("2026-08-01T12:00:00.000Z");
  await openOrCreateSession(dataRoot, config, pending.runtimeSessionId);
  // Commit the CAS: old -> closed, new -> active.
  const next = store.activateRollover("2026-08-01T12:00:00.000Z");
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    assert.equal(host.getCurrentEpoch().epochId, next.epochId);
    assert.equal(host.sessionStatus().status, "active");
    // The old epoch is archived as closed; the new Session is real and empty.
    const archives = host.archives(50);
    const oldEpoch = archives.find((entry) => entry.epochId === active.epochId);
    assert.equal(oldEpoch?.status, "closed");
    const status = host.sessionStatus();
    assert.equal(status.runtimeSessionId, next.runtimeSessionId);
    assert.notEqual(status.runtimeSessionId, active.runtimeSessionId);
  } finally {
    await host.shutdown();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("IrisHost: A3 — rollover requires a native-settled token, not just idle", async () => {
  // A freshly started Host is `idle` but has NO settled authorization: a
  // pending admin rollover must NOT switch the Epoch until an invocation
  // actually reaches native settled on the active Epoch.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a3-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsubscribe = host.onEvent((event) => events.push(event.type));
  try {
    const pumpPromise = host.run();
    const epochId = host.getCurrentEpoch().epochId;
    // Request rollover while idle with NO settled ever observed.
    host.requestRollover("no_settled_never");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      host.getCurrentEpoch().epochId,
      epochId,
      "A3: rollover must not fire without a native-settled token",
    );
    assert.equal(events.includes("rollover_completed"), false);

    // After a real invocation settles, the token is produced and consumed:
    // rollover may then fire.
    host.acceptInput(makeInput("a3-0001"), "a3-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);
    // Re-request after the settled boundary, then wait for the switch.
    host.requestRollover("after_settled");
    await waitFor(() => events.includes("rollover_completed"));
    assert.notEqual(host.getCurrentEpoch().epochId, epochId);
    await host.shutdown();
    await pumpPromise;
  } finally {
    unsubscribe();
    await host.shutdown().catch(() => undefined);
  }
});

test("IrisHost: A5 — active Epoch with missing Session is not-ready/corrupt", async () => {
  // An existing active Epoch whose Pi Session row is missing must fail closed
  // at startup (never silently create an empty Session masquerading as the
  // lost history).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a5-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive("2026-08-01T12:00:00.000Z"); // Epoch exists, Session does NOT
  store.close();

  await assert.rejects(
    IrisHost.open({ dataRoot, config, provider: "mock" }),
    /missing\/corrupt: Pi Session/,
  );
  // The lock was released by the failed startup (re-openable after repair).
  const { SqliteSessionRepo, createNodeSqliteFactory } =
    await import("@earendil-works/pi-storage-sqlite-node");
  const { nodeSqliteRepoEnv } = await import("../src/runtime/pi-env.js");
  const repo = new SqliteSessionRepo({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  await repo.create({ id: "iris-runtime-2026-08-01-1", cwd: dataRoot });
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  await host.shutdown();
});

test("IrisHost: A1 — accepted record whose Pi pair exists is promoted, not re-prompted", async () => {
  // Simulate: an input was accepted AND its UserMessage + companion pair was
  // durably committed to the Pi Session, but the process crashed before
  // settled. On restart the record must be promoted to session_committed —
  // NOT re-prompted (no second UserMessage).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-a1-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // First run: accept + fully settle the input (creates the Pi pair).
  const first = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const pump1 = first.run();
  const events1: string[] = [];
  const unsub1 = first.onEvent((e) => events1.push(e.type));
  first.acceptInput(makeInput("a1-0001"), "a1-0001");
  await waitFor(() => events1.includes("settled"));
  const record = first.getIngress().getRecord("a1-0001", 1);
  assert.equal(record?.state, "session_committed");
  unsub1();
  await first.shutdown();
  await pump1;

  // Simulate the crash-before-settled window: rewind the record to `accepted`
  // (the Pi pair still exists in the Session).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.rewindToAccepted("a1-0001", 1);
  ledger.close();

  // Restart: the record must be promoted to session_committed by startup
  // reconciliation (the full pair exists) and never re-prompted.
  const restarted = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events2: string[] = [];
  const unsub2 = restarted.onEvent((e) => events2.push(e.type));
  const pump2 = restarted.run();
  // Give the pump time to run if it (wrongly) tried to re-prompt; the input
  // is already bound to a Pi pair, so it must NOT be prompted again.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = restarted.getIngress().getRecord("a1-0001", 1);
  assert.equal(
    after?.state,
    "session_committed",
    "A1: full pair must be promoted, not re-prompted",
  );
  assert.equal(
    events2.includes("turn_start"),
    false,
    "A1: committed input must never be re-prompted",
  );
  unsub2();
  await restarted.shutdown();
  await pump2;
});

test("review-pass2 #1: partial pair (UserMessage w/o companion) fails closed, never re-prompted", async () => {
  // Simulate the crash window AFTER the UserMessage was appended but BEFORE
  // the companion: on restart the accepted record must be marked rejected
  // (partial_pair_incomplete) — NOT re-prompted (no second UserMessage).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-partial-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  // Create active Epoch + Session, then append ONLY the UserMessage frames
  // (no iris_input_meta companion) for a known input.
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  await session.appendMessage({
    role: "user",
    content: "IRIS_INPUT_V1\ninline_text:10\nhello iris\n",
    timestamp: Date.now(),
  });
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();

  // Accept the same input durably (simulating the crash-left accepted record).
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("partial-0001", "hello iris"), "partial-0001");
  ledger.close();

  // Restart: reconciliation must classify the orphan UserMessage as a partial
  // pair and mark the record rejected — no re-prompt.
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  const pump = host.run();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const record = host.getIngress().getRecord("partial-0001", 1);
  assert.equal(record?.state, "rejected", "partial pair must fail closed");
  assert.equal(record?.rejectionCode, "partial_pair_incomplete");
  assert.equal(events.includes("turn_start"), false, "partial pair must never re-prompt");
  unsub();
  await host.shutdown();
  await pump;
});

test("review-pass2 #2: archives-only data root creates a fresh Epoch + Session", async () => {
  // No active Epoch, but closed archives exist: startup must create a new
  // active Epoch AND its fresh Session (not fail with a missing Session).
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-archives-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const old = store.ensureActive("2026-08-01T10:00:00.000Z");
  store.markClosed(old.epochId, "closed", "2026-08-01T11:00:00.000Z");
  // Archive Session row exists but its Epoch is closed.
  await openOrCreateSession(dataRoot, config, old.runtimeSessionId);
  store.close();

  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    const current = host.getCurrentEpoch();
    assert.notEqual(current.epochId, old.epochId, "a fresh active Epoch must be created");
    assert.equal(host.sessionStatus().status, "active");
  } finally {
    await host.shutdown();
  }
});

test("review-pass2 #3: settled token is bound to its invocation and consumed once", async () => {
  // The one-time token semantics: a settled invocation produces a token, a
  // rollover request consumes it exactly once (a second request with no new
  // settled does nothing), and a fresh invocation replaces it.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-staletoken-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  try {
    const pump = host.run();
    const epochId = host.getCurrentEpoch().epochId;
    // Invocation A settles — token produced but rollover NOT requested.
    host.acceptInput(makeInput("a-0001"), "a-0001");
    await waitFor(() => events.filter((e) => e === "settled").length >= 1);

    // Request rollover now (token present) → switch happens and consumes it.
    host.requestRollover("after_a_settled");
    await waitFor(() => events.includes("rollover_completed"));
    assert.notEqual(host.getCurrentEpoch().epochId, epochId, "token must authorize the switch");
    await host.shutdown();
    await pump;
  } finally {
    unsub();
    await host.shutdown().catch(() => undefined);
  }
});

test("review-pass2 #5: Host acceptInput validates and is the only normalization authority", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-validate-"));
  const config = defaultAgentConfig();
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  try {
    // Malformed input (missing triggerOrigin) is rejected by the Host.
    assert.throws(
      () =>
        host.acceptInput(
          {
            inputId: "x",
            blocks: [
              {
                blockId: "b1",
                sourceOrigin: directUserRequest(),
                content: { mode: "inline_text", text: "hi" },
                contentHash: "",
              },
            ],
          },
          "x",
        ),
      /triggerOrigin/,
    );
    // inputId mismatch between transport and envelope is rejected.
    assert.throws(
      () => host.acceptInput(makeInput("env-0001"), "transport-id-mismatch"),
      /does not match envelope inputId/,
    );
  } finally {
    await host.shutdown();
  }
});

test("review-pass3 #1: corrupt companion pairKey/layout is NOT a verified full pair", async () => {
  // A companion carrying the right inputId but a WRONG pairKey or layout hash
  // must not promote the ingress record — identity-safe verification.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-badpair-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  const wire = "IRIS_INPUT_V1\ninline_text:10\nhello iris\n";
  await session.appendMessage({ role: "user", content: wire, timestamp: Date.now() });
  // Companion with the right inputId but a WRONG pairKey (all zeros).
  await session.appendCustomMessageEntry("iris_input_meta", "IRIS_INPUT_META_V1", false, {
    iris: {
      schemaVersion: 1,
      inputId: "corrupt-0001",
      pairKey: "0".repeat(64),
      contentLayoutHash: "0".repeat(64),
      blocks: [],
    },
  });
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();

  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("corrupt-0001", "hello iris"), "corrupt-0001");
  ledger.close();

  // The corrupt pair must NOT be verified as a full pair: the UserMessage
  // wire exists but the companion fails pairKey/layout verification, so the
  // record enters partial/incomplete recovery (rejected, never re-prompted,
  // never guessed). The corrupt companion must not block delivery NOR falsely
  // commit.
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  const pump = host.run();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const record = host.getIngress().getRecord("corrupt-0001", 1);
  assert.equal(
    record?.rejectionCode,
    "partial_pair_incomplete",
    "corrupt companion must not be trusted: partial recovery, no false commit",
  );
  assert.equal(events.includes("turn_start"), false, "partial recovery must not re-prompt");
  unsub();
  await host.shutdown();
  await pump;
});

test("review-pass3 #2: two inputs with identical body under different inputIds are classified independently", async () => {
  // Same wire, different inputId: an orphan UserMessage (no companion) for
  // input A must NOT reject input B (same body) that was never appended.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-ambig-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.ensureActive("2026-08-01T12:00:00.000Z");
  store.close();
  const sessionHandle = await openOrCreateSession(dataRoot, config, active.runtimeSessionId);
  const session = sessionHandle.session;
  // UserMessage for input "a-0001" with body "same body" — NO companion.
  await session.appendMessage({
    role: "user",
    content: "IRIS_INPUT_V1\ninline_text:9\nsame body\n",
    timestamp: Date.now(),
  });
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();

  // BOTH a-0001 and b-0001 accepted with the SAME body.
  const { InputAcceptanceLedger } = await import("../src/host/ingress.js");
  const ledger = new InputAcceptanceLedger(paths.ingressDb, paths.blobsIngress, 20, 1);
  ledger.accept(makeInput("a-0001", "same body"), "a-0001");
  ledger.accept(makeInput("b-0001", "same body"), "b-0001");
  ledger.close();

  // The orphan UserMessage wire matches BOTH envelopes -> ambiguous recovery:
  // neither is silently committed, neither is blindly re-prompted as "no
  // append". Both become rejected ambiguous_wire_recovery (safe: no second
  // logical input can be appended, and no wrong identity is guessed).
  const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
  const events: string[] = [];
  const unsub = host.onEvent((e) => events.push(e.type));
  const pump = host.run();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const recA = host.getIngress().getRecord("a-0001", 1);
  const recB = host.getIngress().getRecord("b-0001", 1);
  assert.equal(recA?.rejectionCode, "ambiguous_wire_recovery");
  assert.equal(recB?.rejectionCode, "ambiguous_wire_recovery");
  assert.equal(events.includes("turn_start"), false, "ambiguous recovery must not re-prompt");
  unsub();
  await host.shutdown();
  await pump;
});

test("review-pass3 #3: rollover post-construction fault flips not-ready and releases resources", async () => {
  // Fault injection on each post-construction window (dispose_old,
  // activate_rollover, cas_swap): the rollover must throw deterministically,
  // the pump must flip not-ready, and shutdown must still release the lock.
  for (const fault of ["dispose_old", "activate_rollover", "cas_swap"] as const) {
    const dataRoot = mkdtempSync(join(tmpdir(), `iris-host-fault-${fault}-`));
    const config = defaultAgentConfig();
    const host = await IrisHost.open({ dataRoot, config, provider: "mock" });
    host._setFaultPoint(fault);
    const events: string[] = [];
    const unsub = host.onEvent((e) => events.push(e.type));
    let pump: Promise<void>;
    try {
      pump = host.run();
      host.acceptInput(makeInput(`f-${fault}`), `f-${fault}`);
      // The invocation settles (token produced); the pending rollover then
      // faults at the injected point.
      await waitFor(() => events.filter((e) => e === "settled").length >= 1);
      host.requestRollover(`fault_${fault}`);
      // The pump must fail (not-ready), NOT silently mis-switch.
      const messages = {
        dispose_old: "old Capsule dispose failure",
        activate_rollover: "epoch activation failure",
        cas_swap: "registry swap failure",
      } as const;
      await assert.rejects(pump, new RegExp(messages[fault]));
      assert.equal(host.health().ready, false, "rollover fault must flip not-ready");
    } finally {
      unsub();
      // Shutdown must still release the lock (no leak).
      await host.shutdown().catch(() => undefined);
      // Lock is re-acquirable: a fresh host opens immediately.
      const second = await IrisHost.open({ dataRoot, config, provider: "mock" });
      await second.shutdown();
    }
  }
});
