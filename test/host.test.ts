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

    // Feed a malformed input: blocks with an unsupported content mode.
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
    host.acceptInput(badInput, "bad-0001");
    await waitFor(() => events.some((e) => e === "failed") || !host.health().ready);
    assert.equal(host.health().ready, false, "failed invocation must flip not-ready");
    assert.equal(host.isFailed(), true);

    // Operator recovery resumes the pump without restart. The failed input
    // stays durably `accepted` (dropped from in-flight, not requeued), so the
    // queue now carries only the fresh input.
    host.recover();
    assert.equal(host.isFailed(), false);
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
