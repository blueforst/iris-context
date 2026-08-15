/**
 * Phase B review finding: the P5 projection path (projectP5Unit +
 * computeContextMessageUnitContentHashV1) is the ONLY tamper-detection
 * defense for durable ContextMessageUnitV1 semantic content entering a
 * ContextGenerationV2, and it previously had zero test coverage.
 *
 * This suite proves:
 *   1. P5 durable units project 1:1 into ContextUnitV2 (identity/schema/hash
 *      reused, no second mapper) and land in the correct P5 layerEnds range.
 *   2. Semantic tampering that keeps the stored contentHash fails closed at
 *      the projection boundary (A7 #117).
 *   3. computeContextMessageUnitContentHashV1 is deterministic (key-order
 *      independent) and versioned.
 *   4. Generated migration fixtures are consumed by the V1→V2 fence / strict
 *      validator (v1 rejected-or-migrated, v2 passes, mixed rejected).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContextMessageUnitV1,
  type JsonValue,
  CONTEXT_MESSAGE_UNIT_CONTENT_HASH_BASIS_VERSION,
  computeContextMessageUnitContentHashV1,
  validateGenerationV2Strict,
  v1ToF2Fence,
} from "../src/contracts/context-v27.js";
import {
  buildContextGenerationV2,
  type FrozenContextSources,
} from "../src/context/generation-builder.js";

import v1FlatGeneration from "../contracts/generated/migration-fixtures/v1-flat-generation.fixture.json" with { type: "json" };
import v2Generation from "../contracts/generated/migration-fixtures/v2-generation.fixture.json" with { type: "json" };
import v2V1MixedGeneration from "../contracts/generated/migration-fixtures/v2-v1-mixed-generation.fixture.json" with { type: "json" };

const LINEAGE = "test-lineage-p5";
const SOURCE_SNAPSHOT_HASH = "test-source-snapshot-p5";

function makeDurableUnit(input: {
  contextUnitId: string;
  kind: ContextMessageUnitV1["kind"];
  semanticSchemaId: string;
  semanticContent: JsonValue;
  disposition?: ContextMessageUnitV1["historianDisposition"];
  derivationRefs?: ContextMessageUnitV1["derivationRefs"];
  contextSeq?: number;
}): ContextMessageUnitV1 {
  const derivationRefs = input.derivationRefs ?? { schemaId: "iris.semantic_derivation_refs.v1" };
  const contentHash = computeContextMessageUnitContentHashV1({
    semanticSchemaId: input.semanticSchemaId,
    kind: input.kind,
    historianDisposition: input.disposition ?? "include",
    derivationRefs,
    semanticContent: input.semanticContent,
  });
  return {
    schemaId: "iris.context_message_unit.v1",
    contextUnitId: input.contextUnitId,
    contextLineageId: LINEAGE,
    contextSeq: input.contextSeq ?? 1,
    runtimeEventId: `event-${input.contextUnitId}`,
    kind: input.kind,
    semanticSchemaId: input.semanticSchemaId,
    semanticContent: input.semanticContent,
    historianDisposition: input.disposition ?? "include",
    derivationRefs,
    contentHash,
    lifecycleState: "committed",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function emptyFrozenSources(p5Units: readonly ContextMessageUnitV1[]): FrozenContextSources {
  return {
    contextLineageId: LINEAGE,
    sourceSnapshotHash: SOURCE_SNAPSHOT_HASH,
    p0Units: [],
    p1Units: [],
    p2Units: [],
    p3Units: [],
    p4Units: [],
    p5Units,
  };
}

test("P5: durable unit projects 1:1 into ContextUnitV2 with identity/schema/hash reuse", () => {
  const cmu = makeDurableUnit({
    contextUnitId: "unit-user-0001",
    kind: "user",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    semanticContent: { role: "user", content: "hello" },
  });

  const generation = buildContextGenerationV2(
    emptyFrozenSources([cmu]),
    "gen-p5-0001",
    "2026-08-01T00:00:00.000Z",
  );

  // 1:1 reuse — no second mapper, no re-derivation
  const unit = generation.units[0];
  assert.equal(unit?.header.contextUnitId, cmu.contextUnitId);
  assert.equal(unit?.header.semanticSchemaId, cmu.semanticSchemaId);
  assert.equal(unit?.header.contentHash, cmu.contentHash);
  assert.equal(unit?.header.source.sourceId, cmu.contextUnitId);
  assert.equal(unit?.header.source.sourceHash, cmu.contentHash);
  assert.deepEqual(unit?.semanticContent, cmu.semanticContent);

  // P5 boundary: all units land in [layerEnds[4], layerEnds[5])
  const [, , , , e4, e5] = generation.header.layerEnds;
  assert.equal(e5, generation.units.length);
  assert.equal(e5, 1);
  assert.equal(e4, 0);

  // The generation passes strict validation (hash recompute + layer ends)
  const check = validateGenerationV2Strict(generation);
  assert.equal(check.valid, true, check.reason ?? "expected valid generation");
});

test("P5: multiple durable units keep order and boundaries (P3/P4 empty)", () => {
  const units = [
    makeDurableUnit({
      contextUnitId: "unit-user-0001",
      kind: "user",
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      semanticContent: { role: "user", content: "first" },
      contextSeq: 1,
    }),
    makeDurableUnit({
      contextUnitId: "unit-tool-0002",
      kind: "tool_result",
      semanticSchemaId: "iris.semantic.context_message.tool_result.v1",
      semanticContent: {
        role: "toolResult",
        toolCallId: "call-0001",
        toolName: "test_read_tool",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1722470400000,
      },
      contextSeq: 2,
    }),
    makeDurableUnit({
      contextUnitId: "unit-assistant-0003",
      kind: "assistant",
      semanticSchemaId: "iris.semantic.context_message.assistant.v1",
      semanticContent: { role: "assistant", content: "done", timestamp: 1722470400000 },
      contextSeq: 3,
    }),
  ];

  const generation = buildContextGenerationV2(
    emptyFrozenSources(units),
    "gen-p5-0002",
    "2026-08-01T00:00:00.000Z",
  );

  assert.equal(generation.units.length, 3);
  assert.deepEqual(
    generation.units.map((u) => u.header.contextUnitId),
    ["unit-user-0001", "unit-tool-0002", "unit-assistant-0003"],
  );
  const [e0, , , , e4, e5] = generation.header.layerEnds;
  assert.equal(e0, 0);
  assert.equal(e4, 0);
  assert.equal(e5, 3);

  const check = validateGenerationV2Strict(generation);
  assert.equal(check.valid, true, check.reason ?? "expected valid generation");
});

test("P5: tampered semanticContent (stored hash kept) fails closed at projection", () => {
  const cmu = makeDurableUnit({
    contextUnitId: "unit-user-0001",
    kind: "user",
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    semanticContent: { role: "user", content: "original" },
  });

  // Tamper: mutate semanticContent but keep the stored contentHash.
  const tampered: ContextMessageUnitV1 = {
    ...cmu,
    semanticContent: { role: "user", content: "MUTATED BY ATTACKER" },
  };
  // Sanity: the stored hash no longer matches the tampered content.
  const recomputed = computeContextMessageUnitContentHashV1({
    semanticSchemaId: tampered.semanticSchemaId,
    kind: tampered.kind,
    historianDisposition: tampered.historianDisposition,
    derivationRefs: tampered.derivationRefs ?? {
      schemaId: "iris.semantic_derivation_refs.v1",
    },
    semanticContent: tampered.semanticContent,
  });
  assert.notEqual(recomputed, tampered.contentHash);

  // The builder must fail closed — this is the ONLY tamper defense.
  assert.throws(
    () =>
      buildContextGenerationV2(
        emptyFrozenSources([tampered]),
        "gen-p5-tamper",
        "2026-08-01T00:00:00.000Z",
      ),
    /contentHash mismatch/,
  );
});

test("P5: hash is deterministic and versioned (key-order independent)", () => {
  const content = { role: "user", content: "hello", nested: { a: 1, b: [1, 2] } };
  const derivationRefs = {
    schemaId: "iris.semantic_derivation_refs.v1" as const,
    memoryRefs: ["m1", "m2"],
    sourceContextMessageUnitIds: ["u1", "u2"],
  };
  const h1 = computeContextMessageUnitContentHashV1({
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    kind: "user",
    historianDisposition: "include",
    derivationRefs,
    semanticContent: content,
  });
  // Same logical basis with different object key insertion order must hash equal.
  const h3 = computeContextMessageUnitContentHashV1({
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    kind: "user",
    historianDisposition: "include",
    derivationRefs: {
      schemaId: "iris.semantic_derivation_refs.v1",
      memoryRefs: ["m1", "m2"],
      sourceContextMessageUnitIds: ["u1", "u2"],
    },
    semanticContent: { nested: { b: [1, 2], a: 1 }, content: "hello", role: "user" },
  });
  assert.equal(h1, h3);

  // Ordered arrays are part of the basis: reordering derivation refs is a
  // DIFFERENT basis and must hash differently (no silent normalization).
  const h2 = computeContextMessageUnitContentHashV1({
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    kind: "user",
    historianDisposition: "include",
    derivationRefs: {
      ...derivationRefs,
      memoryRefs: ["m2", "m1"],
      sourceContextMessageUnitIds: ["u2", "u1"],
    },
    semanticContent: content,
  });
  assert.notEqual(h1, h2);

  assert.match(
    CONTEXT_MESSAGE_UNIT_CONTENT_HASH_BASIS_VERSION,
    /^iris\.context_message_unit\.content_hash\.v1$/,
  );

  // Different semantic content must hash differently.
  const h4 = computeContextMessageUnitContentHashV1({
    semanticSchemaId: "iris.semantic.context_message.user.v1",
    kind: "user",
    historianDisposition: "include",
    derivationRefs,
    semanticContent: { role: "user", content: "world" },
  });
  assert.notEqual(h1, h4);
});

test("migration fixtures: v1 flat generation is fenced (rejected or migrated deterministically)", () => {
  const result = v1ToF2Fence(
    v1FlatGeneration,
    "fixture-lineage-v1",
    "fixture-gen-v2-0001",
    "fixture-source-snapshot-v2",
    "2026-08-01T00:00:00Z",
  );
  assert.ok(result.outcome === "rejected" || result.outcome === "migrated");
  if (result.outcome === "migrated") {
    const check = validateGenerationV2Strict(result.migrated);
    assert.equal(
      check.valid,
      true,
      check.reason ?? "migrated output must pass strict V2 validation",
    );
  }
});

test("migration fixtures: v2 generation passes strict validation", () => {
  const check = validateGenerationV2Strict(v2Generation);
  assert.equal(check.valid, true, check.reason ?? "v2 fixture must be valid");
});

test("migration fixtures: v2-v1 mixed generation is rejected (no V1/V2 mixing)", () => {
  const check = validateGenerationV2Strict(v2V1MixedGeneration);
  assert.equal(check.valid, false);
});
