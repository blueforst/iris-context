/**
 * Provider-neutral Memory Observation/Publication authoring 测试（Phase D）。
 *
 * 证明 Historian core 输出不包含任何 Graphiti 形状字段（无 episode/
 * entity/fact/edge/group/projectionVersion/targetGroupId），且可以被一个
 * minimal 非 Graphiti fake engine 直接消费。
 */
import test from "node:test";

import assert from "node:assert/strict";

import { authorMemoryObservations } from "../src/historian/historian-publication.js";
import { buildCompartment } from "../src/historian/historian-compartment.js";
import { historianBatchRangeHash } from "../src/contracts/historian.js";
import type {
  MemoryObservationV1,
  MemoryPublicationV1,
} from "../src/contracts/memory-publication.js";
import { computePublicationOutputHash } from "../src/contracts/memory-publication.js";
import {
  STUB_LINEAGE_ID,
  emptyDerivationRefs,
  fixtureUnit,
} from "./helpers/historian-context-stub.js";

const GRAPHITI_FIELD_NAMES = [
  "episode",
  "episodes",
  "episodeId",
  "episodeSources",
  "entity",
  "entities",
  "facts",
  "edges",
  "group",
  "groupId",
  "targetGroupId",
  "projectionVersion",
  "graphiti",
  "neo4j",
];

/** 递归检查对象里不出现任何 Graphiti 形状字段名（结构级证明）。 */
function assertNoGraphitiShape(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoGraphitiShape(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      assert.ok(
        !GRAPHITI_FIELD_NAMES.includes(key),
        `${path}.${key}: forbidden Graphiti-shaped field name`,
      );
      assertNoGraphitiShape(record[key], `${path}.${key}`);
    }
  }
}

function batchUnits() {
  return [
    fixtureUnit({
      contextSeq: 1,
      kind: "user",
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      semanticContent: { role: "user", content: "please summarize iris" },
    }),
    fixtureUnit({
      contextSeq: 2,
      kind: "assistant",
      semanticSchemaId: "iris.semantic.context_message.assistant.v1",
      semanticContent: { role: "assistant", content: "iris is a context ledger" },
      derivationRefs: emptyDerivationRefs(),
    }),
    fixtureUnit({
      contextSeq: 3,
      kind: "tool_result",
      semanticSchemaId: "iris.semantic.context_message.tool_result.v1",
      semanticContent: { role: "toolResult", content: "ok" },
    }),
  ];
}

function authorFixture() {
  const units = batchUnits();
  const batch = {
    schemaId: "iris.historian_batch.v1" as const,
    batchId: `batch-${STUB_LINEAGE_ID}-1-3`,
    claimId: "claim-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 3,
    rangeHash: "",
    semanticSchemaIds: [],
    units,
    estimatedTokens: 5,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  batch.rangeHash = historianBatchRangeHash(batch);
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "s",
    compartmentSequence: 1,
    units,
  });
  assert.ok(built, "compartment built");
  return { batch, built };
}

test("provider-neutral: authored observations carry NO Graphiti-shaped fields", () => {
  const { batch, built } = authorFixture();
  const authored = authorMemoryObservations({
    lineageId: STUB_LINEAGE_ID,
    batch,
    evidenceBasis: built.evidenceBasis,
    derivedOnly: built.derivedOnly,
    now: "2026-08-01T00:00:00.000Z",
  });
  assert.ok(authored.observations.length >= 2, "observations authored per semantic partition");
  for (const observation of authored.observations) {
    assert.equal(observation.schemaId, "iris.memory_observation.v1");
    assert.ok(observation.observationId.startsWith("obs-"));
    assert.equal(observation.contextLineageId, STUB_LINEAGE_ID);
    assert.ok(observation.evidenceBasis.length > 0, "evidence basis present");
    assertNoGraphitiShape(observation, "observation");
    const json = JSON.stringify(observation);
    assert.ok(!json.toLowerCase().includes("graphiti"), "no graphiti reference");
    assert.ok(!json.includes("projectionVersion"), "no projectionVersion");
  }
});

test("provider-neutral: MemoryPublicationV1 is self-contained and non-Graphiti", () => {
  const { batch, built } = authorFixture();
  const authored = authorMemoryObservations({
    lineageId: STUB_LINEAGE_ID,
    batch,
    evidenceBasis: built.evidenceBasis,
    derivedOnly: built.derivedOnly,
    now: "2026-08-01T00:00:00.000Z",
  });
  const publication: MemoryPublicationV1 = {
    schemaId: "iris.memory_publication.v1",
    publicationId: "publication-1",
    publicationSequence: 1,
    lineageId: STUB_LINEAGE_ID,
    contextRange: {
      contextLineageId: STUB_LINEAGE_ID,
      fromContextSeq: batch.fromContextSeq,
      throughContextSeq: batch.throughContextSeq,
      rangeHash: batch.rangeHash,
    },
    observations: authored.observations,
    compartmentRevisions: [
      {
        compartmentId: built.compartment.compartmentId,
        compartmentSequence: 1,
        headContextSeq: 3,
        summary: built.compartment.content.slice(0, 4000),
        importance: built.compartment.importance,
        episodeType: built.compartment.episodeType,
        memoryRefs: authored.memoryRefs,
      },
    ],
    derivationSummary: { derivedOnly: built.derivedOnly, memoryRefs: authored.memoryRefs },
    outputHash: "",
    publishedAt: "2026-08-01T00:00:00.000Z",
    processingProfileId: "profile-1",
  };
  publication.outputHash = computePublicationOutputHash({
    schemaId: publication.schemaId,
    publicationId: publication.publicationId,
    publicationSequence: publication.publicationSequence,
    lineageId: publication.lineageId,
    contextRange: publication.contextRange,
    observations: publication.observations,
    compartmentRevisions: publication.compartmentRevisions,
    derivationSummary: publication.derivationSummary,
    publishedAt: publication.publishedAt,
    processingProfileId: publication.processingProfileId,
  });
  const json = JSON.stringify(publication);
  assertNoGraphitiShape(publication, "publication");
  assert.ok(!json.toLowerCase().includes("graphiti"), "no graphiti reference");
  assert.ok(!json.includes("projectionVersion"), "no projectionVersion");
  assert.ok(!json.includes("episodeSources"), "no episodeSources");
  assert.ok(publication.outputHash.length > 0);

  // 一个 minimal 非 Graphiti fake engine 可以直接消费（无 provider SDK）。
  const fakeEngine = {
    ingest(publicationEnvelope: MemoryPublicationV1): { observations: number; lineageId: string } {
      return {
        observations: publicationEnvelope.observations.length,
        lineageId: publicationEnvelope.lineageId,
      };
    },
  };
  const consumed = fakeEngine.ingest(publication);
  assert.equal(consumed.observations, publication.observations.length);
  assert.equal(consumed.lineageId, STUB_LINEAGE_ID);

  // 每条 observation 的 evidenceBasis 可被消费方用于来源审计。
  for (const observation of publication.observations as MemoryObservationV1[]) {
    for (const ref of observation.evidenceBasis) {
      assert.equal(ref.schemaId, "iris.evidence_basis_ref.v1");
      assert.ok(ref.contextUnitId.length > 0);
      assert.ok(ref.contentHash.length > 0);
      assert.equal(ref.historianDisposition, "include");
    }
  }
});

test("provider-neutral: derived-only batch yields derivedOnly observations without new basis", () => {
  const echoUnit = fixtureUnit({
    contextSeq: 1,
    kind: "assistant",
    semanticSchemaId: "iris.semantic.context_message.assistant.v1",
    semanticContent: { role: "assistant", content: "recall" },
    derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: ["mem-1"] },
  });
  const batch = {
    schemaId: "iris.historian_batch.v1" as const,
    batchId: `batch-${STUB_LINEAGE_ID}-1-1`,
    claimId: "c",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 1,
    rangeHash: "",
    semanticSchemaIds: [],
    units: [echoUnit],
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  batch.rangeHash = historianBatchRangeHash(batch);
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "s",
    compartmentSequence: 1,
    units: [echoUnit],
  });
  assert.ok(built);
  assert.equal(built?.derivedOnly, true);
  const authored = authorMemoryObservations({
    lineageId: STUB_LINEAGE_ID,
    batch,
    evidenceBasis: built?.evidenceBasis ?? [],
    derivedOnly: built?.derivedOnly ?? true,
    now: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(authored.observations.length, 1);
  assert.equal(authored.observations[0]?.derivedOnly, true);
  assert.equal(authored.observations[0]?.evidenceBasis.length, 0, "derived-only → no new basis");
});
