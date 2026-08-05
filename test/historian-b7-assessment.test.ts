/**
 * R3-P2 移植说明：本测试从已验证的 `agent/r2-product-parity-fix-r3-historian`
 * 分支（commit 5b94db7）的 `test/historian-b7-assessment.test.ts` 移植。
 *
 * 适配点：无。b7 测试只消费 `deriveMemoryAssessments` / `assessmentId` /
 * `HistorianStore.insertAssessmentDelta`，这些符号在 main 上均原样存在，
 * 不依赖 R3-P1 的 `freezeBoundary` 签名变更。代码逻辑与分支保持一致。
 *
 * Feature B7 — MemoryAssessmentDelta & recall projection boundary。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import {
  deriveMemoryAssessments,
  assessmentId,
  type MemoryAssessmentDelta,
} from "../src/historian/historian-assessment.js";
import type { EvidenceSet } from "../src/historian/historian-compartment.js";

const SESSION = "iris-runtime-2026-08-01-1";

function evidenceSet(id: string, payloads: string[]): EvidenceSet {
  return {
    evidenceSetId: id,
    runtimeSessionId: SESSION,
    compartmentId: `compartment-${id}`,
    startEntrySeq: 1,
    endEntrySeq: payloads.length,
    sourceRangeHash: `hash-${id}`,
    entries: payloads.map((payload, index) => ({
      entrySeq: index + 1,
      entryId: `entry-${id}-${index}`,
      role: "user",
      payload,
    })),
  };
}

function storeFixture(): { store: HistorianStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b7-"));
  return { store: HistorianStore.open({ databasePath: join(dir, "historian.db") }), dir };
}

test("B7: only memoryRefs that appear in a recall projection can be assessment targets", async () => {
  const { store, dir } = storeFixture();
  try {
    const deltas = deriveMemoryAssessments({
      runtimeSessionId: SESSION,
      publicationSequence: 1,
      newEvidenceSets: [evidenceSet("e1", ["the user confirms the deployment plan"])],
      recallProjections: [
        { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
      ],
    });
    assert.ok(deltas.length >= 1);
    for (const delta of deltas) {
      assert.equal(delta.targetMemoryRef, "memory-ref-deployment");
    }
    // A NON-recalled memoryRef never becomes a target.
    const targets = deltas.map((d) => d.targetMemoryRef);
    assert.ok(!targets.includes("memory-ref-never-recalled"), "non-recalled ref is not a target");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7: repeated recalls are NOT multiple evidence (deduplicated invocation ids)", async () => {
  const deltas = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 1,
    newEvidenceSets: [evidenceSet("e1", ["supports the deployment plan"])],
    recallProjections: [
      { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
      // Same memoryRef recalled again in the SAME invocation — not twice.
      { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
      {
        invocationId: "inv-2",
        runtimeSessionId: SESSION,
        memoryRefs: ["memory-ref-deployment"],
        recallCounts: { "memory-ref-deployment": 5 },
      },
    ],
  });
  const target = deltas.find((d) => d.targetMemoryRef === "memory-ref-deployment");
  assert.ok(target);
  assert.deepEqual(
    [...target.observedInInvocationIds].sort(),
    ["inv-1", "inv-2"],
    "invocation ids deduplicated; recallCounts never inflate",
  );
});

test("B7: no basis from THIS publication → no assessment (insufficient lineage)", async () => {
  const deltas = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 1,
    newEvidenceSets: [],
    recallProjections: [
      { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-x"] },
    ],
  });
  assert.equal(deltas.length, 0, "no basis evidence → no assessment");
});

test("B7: relation derivation — supports / contradicts / uncertain", async () => {
  const supporting = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 1,
    newEvidenceSets: [evidenceSet("e1", ["the user confirms the deployment plan is correct"])],
    recallProjections: [
      { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
    ],
  });
  assert.equal(supporting[0]?.relation, "supports");

  const contradicting = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 2,
    newEvidenceSets: [
      evidenceSet("e2", ["the user says the deployment plan is wrong and incorrect"]),
    ],
    recallProjections: [
      { invocationId: "inv-2", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
    ],
  });
  assert.equal(contradicting[0]?.relation, "contradicts");

  // Mentioned but no clear relation → uncertain.
  const uncertain = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 3,
    newEvidenceSets: [evidenceSet("e3", ["the deployment topic came up again"])],
    recallProjections: [
      { invocationId: "inv-3", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
    ],
  });
  assert.equal(uncertain[0]?.relation, "uncertain");

  // Not mentioned → no_change (never fabricated support/contradiction).
  const noChange = deriveMemoryAssessments({
    runtimeSessionId: SESSION,
    publicationSequence: 4,
    newEvidenceSets: [evidenceSet("e4", ["completely unrelated weather discussion"])],
    recallProjections: [
      { invocationId: "inv-4", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
    ],
  });
  assert.equal(noChange[0]?.relation, "no_change");
});

test("B7: assessment IDs are deterministic", () => {
  const a1 = assessmentId(SESSION, 1, "memory-ref-x");
  const a2 = assessmentId(SESSION, 1, "memory-ref-x");
  const a3 = assessmentId(SESSION, 2, "memory-ref-x");
  assert.equal(a1, a2, "deterministic for the same input");
  assert.notEqual(a1, a3, "publication sequence changes the id");
  assert.equal(a1.length, 32, "sha256 prefix id");
});

test("B7: deltas persist inside the B5 transaction with basis from THIS publication only", async () => {
  const { store, dir } = storeFixture();
  try {
    const deltas: MemoryAssessmentDelta[] = deriveMemoryAssessments({
      runtimeSessionId: SESSION,
      publicationSequence: 1,
      newEvidenceSets: [evidenceSet("e1", ["supports the deployment plan"])],
      recallProjections: [
        { invocationId: "inv-1", runtimeSessionId: SESSION, memoryRefs: ["memory-ref-deployment"] },
      ],
    });
    assert.ok(deltas.length >= 1);
    store.begin();
    for (const delta of deltas) {
      store.insertAssessmentDelta(delta);
    }
    store.commit();
    const firstDelta = deltas[0];
    assert.ok(firstDelta, "at least one delta persisted");
    const row = store
      .raw()
      .prepare(
        "SELECT assessment_id, target_memory_ref, relation, basis_evidence_set_ids_json FROM memory_assessment_deltas WHERE assessment_id = ?",
      )
      .get(firstDelta.assessmentId) as
      | {
          assessment_id: string;
          target_memory_ref: string;
          relation: string;
          basis_evidence_set_ids_json: string;
        }
      | undefined;
    assert.ok(row, "assessment persisted");
    assert.equal(row.target_memory_ref, "memory-ref-deployment");
    const basis = JSON.parse(row.basis_evidence_set_ids_json) as string[];
    assert.deepEqual(basis, ["e1"], "basis is THIS publication's evidence set");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7: the Historian NEVER modifies Graphiti/RecallDisposition (no write paths exist)", async () => {
  const { store, dir } = storeFixture();
  try {
    // The only memory-related writes are memory_assessment_deltas rows.
    const tables = store
      .raw()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%memory%' OR name LIKE '%graphiti%' OR name LIKE '%recall%'",
      )
      .all() as unknown as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(!names.some((n) => /graphiti/i.test(n)), "no Graphiti table");
    assert.ok(!names.some((n) => /recall_disposition/i.test(n)), "no RecallDisposition table");
    assert.ok(names.includes("memory_assessment_deltas"), "only the assessment delta table");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
