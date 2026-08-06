import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import {
  closeSessionStorage,
  composeProvider,
  makeReadOnlyTestTool,
  openOrCreateSession,
  prepareContextSources,
  rolloverActiveSession,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { attachRuntimeEventSeam } from "../src/runtime/runtime-event-seam.js";

/**
 * Feature 2 cross-repository integration (iris_agent#40): the durable Pi
 * commit receipt journal must be consumed exactly once by the RuntimeEvent
 * ledger across crash/restart, duplicate recovery, out-of-order recovery and
 * session rollover. These tests drive the REAL Pi fork (SqliteSessionRepository
 * + AgentHarness.recoverPendingCommitReceipts) against the REAL iris_agent
 * ledger; they never infer normal semantic events from the Session transcript.
 */

async function setupSlice(
  dataRoot: string,
  config = defaultAgentConfig(),
  now = "2026-08-05T00:00:00.000Z",
) {
  initializeDataRoot(dataRoot, config);
  const paths = resolveDataRootPaths(dataRoot, config);
  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const epoch = epochStore.ensureActive(now);
  const { repo, session } = await openOrCreateSession(dataRoot, config, epoch.runtimeSessionId);
  const { models, model, providerProfileId } = await composeProvider("mock");
  const prepared = prepareContextSources(
    sampleAgentInput(),
    epoch.runtimeSessionId,
    epoch.epochId,
    config,
    now,
  );
  return {
    config,
    now,
    epochStore,
    epoch,
    repo,
    session,
    models,
    model,
    providerProfileId,
    prepared,
    paths,
  };
}

function attachLedger(
  harness: ReturnType<typeof createIrisHarness>["harness"],
  paths: ReturnType<typeof resolveDataRootPaths>,
  runtimeSessionId: string,
  piSessionId: string,
) {
  const ledger = RuntimeEventLedger.open(paths.runtimeLedgerDb);
  attachRuntimeEventSeam(harness, {
    ledger,
    runtimeSessionId,
    piSessionId,
  });
  return ledger;
}

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

test("f2-xrepo: crash between durable append and publication is recovered exactly once", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-crash-"));
  try {
    const s = await setupSlice(dataRoot);

    // "Crash" simulation: record the durable entry + pending receipt at the Pi
    // storage level, but never publish (no recover, no ack) — the process died
    // between append and message_finalized.
    const metadata = await s.session.getMetadata();
    const message = userMessage("crash window message");
    await s.session.appendMessageWithCommitReceipt(message, (entryId) => ({
      sessionId: metadata.id,
      entryId,
      contentHash: "x".repeat(64),
      committedAt: new Date().toISOString(),
    }));
    await expectPending(s, 1);
    await closeSessionStorage(s.repo);
    s.epochStore.close();

    // Restart: reopen the same data root, attach a fresh ledger, recover.
    const s2 = await setupSlice(dataRoot, s.config);
    const { harness: harness2 } = createIrisHarness({
      session: s2.session,
      instanceEpoch: s2.epoch.ordinalWithinDate,
      models: s2.models,
      model: s2.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s2.prepared,
        invocationId: "invocation-f2-crash-restart",
      },
      now: s2.now,
      providerProfileId: s2.providerProfileId,
    });
    const ledger = attachLedger(
      harness2,
      s2.paths,
      s2.epoch.runtimeSessionId,
      s2.epoch.runtimeSessionId,
    );

    const replayed = await harness2.recoverPendingCommitReceipts();
    assert.equal(replayed, 1, "exactly one missed receipt must replay after crash");

    const events = ledger.listBySession(s2.epoch.runtimeSessionId);
    const finalized = events.filter((event) => event.type === "message_finalized");
    assert.equal(finalized.length, 1, "exactly one message_finalized must land in the ledger");
    assert.equal(finalized[0]?.entryId, await s2.session.getLeafId());

    // A second recovery must not re-emit (ack persisted) and the ledger must
    // not gain duplicates.
    assert.equal(await harness2.recoverPendingCommitReceipts(), 0);
    assert.equal(
      ledger.listBySession(s2.epoch.runtimeSessionId).filter((e) => e.type === "message_finalized")
        .length,
      1,
    );

    await expectPending(s2, 0);
    ledger.close();
    await closeSessionStorage(s2.repo);
    s2.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: duplicate recovery does not duplicate ledger commits (exactly-once)", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-dupe-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-dupe",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );

    const metadata = await s.session.getMetadata();
    const message = userMessage("duplicate window");
    await s.session.appendMessageWithCommitReceipt(message, (entryId) => ({
      sessionId: metadata.id,
      entryId,
      contentHash: "y".repeat(64),
      committedAt: new Date().toISOString(),
    }));
    await expectPending(s, 1);

    // Even if recovery runs twice (e.g. two restart paths raced), the ledger
    // idempotency key (message_finalized:sessionId:entryId) must collapse
    // duplicates and the Pi journal must ack only once.
    assert.equal(await harness.recoverPendingCommitReceipts(), 1);
    assert.equal(await harness.recoverPendingCommitReceipts(), 0);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalized.length, 1, "duplicate recovery must not duplicate ledger commits");
    await expectPending(s, 0);

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: out-of-order recovery replays in commit order with stable identity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-order-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-order",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    const texts = ["first", "second", "third"];
    const entryIds: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      assert.ok(text !== undefined, "test vector must exist");
      const { entryId } = await s.session.appendMessageWithCommitReceipt(
        userMessage(text),
        (id) => ({
          sessionId: metadata.id,
          entryId: id,
          contentHash: `h${i}`.padEnd(64, "0"),
          committedAt: new Date(Date.now() + i).toISOString(),
        }),
      );
      entryIds.push(entryId);
    }
    await expectPending(s, 3);

    assert.equal(await harness.recoverPendingCommitReceipts(), 3);
    const finalized = ledger
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalized.length, 3);
    // Commit order preserved and receipt identity (entryId) stable.
    assert.deepEqual(
      finalized.map((e) => e.entryId),
      entryIds,
    );

    ledger.close();
    await closeSessionStorage(s.repo);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

test("f2-xrepo: rollover keeps per-session recovery independent and never resets events", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-f2-rollover-"));
  try {
    const s = await setupSlice(dataRoot);
    const { harness } = createIrisHarness({
      session: s.session,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-1",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger = attachLedger(
      harness,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    const metadata = await s.session.getMetadata();

    // Session A: one committed message with a pending receipt (crash window).
    const aMessage = userMessage("pre-rollover");
    const { entryId: aEntryId } = await s.session.appendMessageWithCommitReceipt(
      aMessage,
      (id) => ({
        sessionId: metadata.id,
        entryId: id,
        contentHash: "a".repeat(64),
        committedAt: new Date().toISOString(),
      }),
    );
    await expectPending(s, 1);

    // Settled-only rollover rotates the Pi session within the same identity
    // lineage; session A stays closed with its pending receipt.
    const rolled = await rolloverActiveSession({
      dataRoot,
      config: s.config,
      now: s.now,
      settledEpochId: s.epoch.epochId,
    });
    assert.notEqual(
      rolled.newSessionId,
      s.epoch.runtimeSessionId,
      "rollover must mint a new runtime session",
    );
    const { repo: repoB, session: sessionB } = await openOrCreateSession(
      dataRoot,
      s.config,
      rolled.newSessionId,
    );

    // Recovery belongs to session A: reopen A's session and replay its
    // pending receipt into A's ledger stream. Session B must not see it.
    const { repo: repoA, session: sessionARestarted } = await openOrCreateSession(
      dataRoot,
      s.config,
      s.epoch.runtimeSessionId,
    );
    const { harness: harnessA } = createIrisHarness({
      session: sessionARestarted,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-a-recover",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledgerA = attachLedger(
      harnessA,
      s.paths,
      s.epoch.runtimeSessionId,
      s.epoch.runtimeSessionId,
    );
    assert.equal(await harnessA.recoverPendingCommitReceipts(), 1);
    const finalizedA = ledgerA
      .listBySession(s.epoch.runtimeSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalizedA.length, 1);
    assert.equal(finalizedA[0]?.entryId, aEntryId);
    await closeSessionStorage(repoA);

    // Session B events continue cleanly (no reset, no cross-talk).
    const { harness: harness2 } = createIrisHarness({
      session: sessionB,
      instanceEpoch: s.epoch.ordinalWithinDate,
      models: s.models,
      model: s.model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation: {
        input: sampleAgentInput(),
        prepared: s.prepared,
        invocationId: "inv-f2-roll-2",
      },
      now: s.now,
      providerProfileId: s.providerProfileId,
    });
    const ledger2 = attachLedger(harness2, s.paths, rolled.newSessionId, rolled.newSessionId);
    await harness2.appendMessage(userMessage("post-rollover"));
    const finalizedB = ledger2
      .listBySession(rolled.newSessionId)
      .filter((e) => e.type === "message_finalized");
    assert.equal(finalizedB.length, 1, "session B events must start clean");
    assert.equal(
      await harness2.recoverPendingCommitReceipts(),
      0,
      "session B has no pending receipts",
    );
    assert.equal((await sessionB.readPendingCommitReceipts()).length, 0);

    ledger.close();
    ledgerA.close();
    ledger2.close();
    await closeSessionStorage(repoB);
    s.epochStore.close();
  } finally {
    // OS tmpdir 管理。
  }
});

async function expectPending(slice: Awaited<ReturnType<typeof setupSlice>>, count: number) {
  const pending = await slice.session.readPendingCommitReceipts();
  assert.equal(
    pending.length,
    count,
    `expected ${count} pending commit receipt(s), got ${pending.length}`,
  );
}
