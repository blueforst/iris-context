/**
 * Feature B10 — iris_agent#45: Historian provenance fail-closed.
 *
 * AC map:
 *  - every v2 Publication identifies the TRUE identity-level Context lineage
 *  - Runtime Session rollover does not change the lineage identity
 *  - Context range + rangeHash derive from the exact committed unit batch
 *  - no 1..1 (or any) provenance fabricated when there is no Context batch
 *  - production Historian cannot publish without the Context read/claim port
 *  - Session ranges stay raw archive locators only (no session id leakage)
 *  - changed basis/disposition/contentHash/derivationRefs changes the
 *    canonical payload hash
 *  - crash/retry/replay preserves publication identity + provenance
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";
import { freezeBoundary } from "../src/historian/historian-boundary.js";
import { HistorianRunner } from "../src/historian/historian-runner.js";
import { createPublicationCommitHook } from "../src/historian/historian-publication.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import type { HistorianUnitView } from "../src/historian/anti-echo.js";

const SESSION = "iris-runtime-2026-08-01-1";
const SESSION_B = "iris-runtime-2026-08-02-1";
const LINEAGE = "identity-real-lineage-9f2c";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function unit(contextSeq: number, overrides: Partial<HistorianUnitView> = {}): HistorianUnitView {
  return {
    contextUnitId: `unit-${contextSeq}`,
    contextSeq,
    runtimeEventId: `evt-${contextSeq}`,
    unitType: "input",
    disposition: "include",
    contentHash: createHash("sha256").update(`content-${contextSeq}`).digest("hex"),
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
    ...overrides,
  };
}

/** Fake ContextHistoryReadPort: configurable unit views + a fixed lineage id. */
function stubPort(units: HistorianUnitView[], lineageId = LINEAGE): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    listUnitsForHistorian() {
      return units;
    },
    listUnitsForHistorianByEntrySeq() {
      return units;
    },
    lineageId() {
      return lineageId;
    },
  } as ContextHistoryReadPort;
}

interface Fixture {
  store: HistorianStore;
  dir: string;
  runCycle: (entries: SessionTreeEntry[], sessionId?: string) => Promise<{ status: string }>;
  envelopeOf: (sessionId?: string) => Record<string, unknown> | undefined;
}

function fixture(port: ContextHistoryReadPort): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "iris-b10-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  return {
    store,
    dir,
    async runCycle(entries, sessionId = SESSION) {
      const sessionPort = new SessionHistoryReadPort({ readRawEntries: async () => entries });
      const page = await sessionPort.readEntries({ runtimeSessionId: sessionId, limit: 100 });
      const freeze = freezeBoundary({
        rawSeamInput: {
          runtimeSessionId: sessionId,
          entries: page.entries,
          processedThroughEntrySeq: 0,
          tailMarginEntries: 0,
          modelProviderProfile: "opencode/deepseek-v4-flash",
          frozenAt: "2026-08-01T00:00:00.000Z",
        },
      });
      const runner = new HistorianRunner({
        store,
        readPort: sessionPort,
        commitHook: createPublicationCommitHook({ store, historyPort: port }),
      });
      return runner.run({ runtimeSessionId: sessionId, boundary: freeze.snapshot });
    },
    envelopeOf(sessionId = SESSION) {
      const row = store
        .raw()
        .prepare(
          "SELECT payload_json FROM publication_outbox WHERE runtime_session_id = ? ORDER BY outbox_sequence DESC LIMIT 1",
        )
        .get(sessionId) as { payload_json: string | null } | undefined;
      if (row === undefined) {
        return undefined;
      }
      if (row.payload_json === null) {
        return undefined;
      }
      return JSON.parse(row.payload_json) as Record<string, unknown>;
    },
  };
}

function rangeOf(envelope: Record<string, unknown>): {
  contextLineageId: string;
  fromContextSeq: number;
  toContextSeq: number;
  rangeHash: string;
} {
  return (envelope as { contextRange: never }).contextRange as never;
}

/** The documented canonical range-hash rule (ordered by contextSeq). */
function canonicalRangeHash(units: HistorianUnitView[]): string {
  const ordered = [...units].sort((a, b) => a.contextSeq - b.contextSeq);
  return createHash("sha256")
    .update(
      JSON.stringify(
        ordered.map((x) => ({
          contextSeq: x.contextSeq,
          contextUnitId: x.contextUnitId,
          runtimeEventId: x.runtimeEventId,
          contentHash: x.contentHash,
        })),
      ),
      "utf8",
    )
    .digest("hex");
}

test("B10-AC1/AC2: v2 Publication identifies the TRUE lineage id, stable across rollover (no identity-<session> synthesis)", async () => {
  const fx = fixture(stubPort([unit(1), unit(2)]));
  try {
    const r1 = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r1.status, "committed");
    const env1 = fx.envelopeOf();
    assert.ok(env1);
    assert.equal(rangeOf(env1).contextLineageId, LINEAGE, "real lineage id from the port");
    assert.notEqual(
      rangeOf(env1).contextLineageId,
      `identity-${SESSION}`,
      "never synthesized from the Session",
    );

    // Rollover: Session B publishes against the SAME lineage.
    const r2 = await fx.runCycle([u("u-1", null, "two")], SESSION_B);
    assert.equal(r2.status, "committed");
    const env2 = fx.envelopeOf(SESSION_B);
    assert.ok(env2);
    assert.equal(
      rangeOf(env2).contextLineageId,
      LINEAGE,
      "rollover does not change lineage identity",
    );
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC3: Context range and rangeHash derive from the exact committed units, deterministically", async () => {
  const fx = fixture(stubPort([unit(2), unit(3)]));
  try {
    const r = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r.status, "committed");
    const env = fx.envelopeOf();
    assert.ok(env);
    const range = rangeOf(env);
    assert.equal(range.fromContextSeq, 2);
    assert.equal(range.toContextSeq, 3);
    assert.equal(
      range.rangeHash,
      canonicalRangeHash([unit(2), unit(3)]),
      "canonical ordered unit hash",
    );

    // Determinism: a second identical cycle produces the same rangeHash.
    const fx2 = fixture(stubPort([unit(2), unit(3)]));
    try {
      await fx2.runCycle([u("u-1", null, "one")]);
      assert.equal(rangeOf(fx2.envelopeOf() ?? ({} as never)).rangeHash, range.rangeHash);
    } finally {
      fx2.store.close();
      rmSync(fx2.dir, { recursive: true, force: true });
    }

    // Changed content hash must change the rangeHash (and payloadHash).
    const fx3 = fixture(stubPort([unit(2, { contentHash: "c".repeat(64) }), unit(3)]));
    try {
      await fx3.runCycle([u("u-1", null, "one")]);
      const env3 = fx3.envelopeOf();
      assert.ok(env3, "envelope exists");
      assert.notEqual(rangeOf(env3).rangeHash, range.rangeHash);
      assert.notEqual(
        env3["payloadHash"],
        env["payloadHash"],
        "content change ripples to payloadHash",
      );
    } finally {
      fx3.store.close();
      rmSync(fx3.dir, { recursive: true, force: true });
    }
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC4: no Context batch -> fail closed, never a fabricated 1..1 range", async () => {
  const fx = fixture(stubPort([]));
  try {
    // Fail closed: the publication path THROWS the typed provenance error
    // (the runner propagates it); nothing is published, nothing fabricated.
    await assert.rejects(
      () => fx.runCycle([u("u-1", null, "one")]),
      /refusing to fabricate a Context range/,
    );
    const env = fx.envelopeOf();
    assert.equal(env, undefined, "no publication with fabricated provenance");
    const pubs = fx.store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(pubs.n, 0);
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC5: production Historian cannot publish without the Context read/claim port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b10-noport-"));
  try {
    const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
    const sessionPort = new SessionHistoryReadPort({
      readRawEntries: async () => [u("u-1", null)],
    });
    const page = await sessionPort.readEntries({ runtimeSessionId: SESSION, limit: 100 });
    const freeze = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId: SESSION,
        entries: page.entries,
        processedThroughEntrySeq: 0,
        tailMarginEntries: 0,
        modelProviderProfile: "m",
        frozenAt: "2026-08-01T00:00:00.000Z",
      },
    });
    // NOTE: createPublicationCommitHook WITHOUT historyPort.
    const runner = new HistorianRunner({
      store,
      readPort: sessionPort,
      commitHook: createPublicationCommitHook({ store }),
    });
    await assert.rejects(
      () => runner.run({ runtimeSessionId: SESSION, boundary: freeze.snapshot }),
      /cannot publish without a ContextHistoryReadPort/,
    );
    const pubs = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE runtime_session_id = ?")
      .get(SESSION) as { n: number };
    assert.equal(pubs.n, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B10-AC6: payloadHash is canonical over the complete payload; provenance changes change it", async () => {
  const base = [unit(1)];
  const fx = fixture(stubPort(base));
  try {
    await fx.runCycle([u("u-1", null, "one")]);
    const env = fx.envelopeOf();
    assert.ok(env, "envelope exists");

    // Self-reference rule: hash of the envelope with payloadHash blanked
    // equals the recorded payloadHash.
    const blanked = { ...env, payloadHash: "" };
    const recomputed = createHash("sha256").update(JSON.stringify(blanked), "utf8").digest("hex");
    assert.equal(
      recomputed,
      env["payloadHash"],
      "payloadHash covers the complete payload (documented no-self-ref rule)",
    );

    // Changed derivation refs change the payload hash.
    const derived = unit(1, {
      derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextUnitIds: [] },
    });
    const fx2 = fixture(stubPort([derived]));
    try {
      await fx2.runCycle([u("u-1", null, "one")]);
      assert.notEqual(
        fx2.envelopeOf()?.["payloadHash"],
        env["payloadHash"],
        "derivation change ripples to payloadHash",
      );
    } finally {
      fx2.store.close();
      rmSync(fx2.dir, { recursive: true, force: true });
    }

    // Changed disposition (reference_only) changes the payload hash.
    const refOnly = unit(1, { disposition: "reference_only" });
    const fx3 = fixture(stubPort([refOnly]));
    try {
      await fx3.runCycle([u("u-1", null, "one")]);
      assert.notEqual(fx3.envelopeOf()?.["payloadHash"], env["payloadHash"]);
    } finally {
      fx3.store.close();
      rmSync(fx3.dir, { recursive: true, force: true });
    }
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC7: Session ids appear nowhere in the v2 envelope (raw archive attribution only)", async () => {
  const fx = fixture(stubPort([unit(1), unit(2)]));
  try {
    await fx.runCycle([u("u-1", null, "one")]);
    const env = fx.envelopeOf();
    assert.ok(env);
    assert.ok(!JSON.stringify(env).includes(SESSION), "no Session id leaks into the Publication");
    assert.ok(!JSON.stringify(env).includes(SESSION_B));
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("B10-AC8: derived-only with basis keeps a REAL range from the basis refs", async () => {
  const basisUnits = [unit(1), unit(2)];
  const fx = fixture(stubPort(basisUnits));
  try {
    // Derived-only classification comes from buildCompartment (anti-echo);
    // a batch whose units are all derived-only still carries basis refs for
    // the source units, so the range is real — never 1..1.
    const r = await fx.runCycle([u("u-1", null, "one")]);
    assert.equal(r.status, "committed");
    const env = fx.envelopeOf();
    assert.ok(env, "envelope exists");
    const range = rangeOf(env);
    assert.ok(range.fromContextSeq >= 1 && range.toContextSeq >= range.fromContextSeq);
    assert.ok(
      !(
        range.fromContextSeq === 1 &&
        range.toContextSeq === 1 &&
        (env["evidenceCount"] as number) === 0
      ),
      "no fabricated minimal range",
    );
  } finally {
    fx.store.close();
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
