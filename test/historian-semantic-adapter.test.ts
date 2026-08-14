/**
 * HistorianSemanticAdapterRegistry 测试（Phase D）。
 *
 * 覆盖：schemaId ownership 冲突 fail-closed、getAdapter/owns、frozen
 * processing profile（adapter 版本集 hash；变化只影响后续 batch）、
 * invokeInterpret 只解释自有 schema 且输入不可变（fail-closed）。
 */
import test from "node:test";

import assert from "node:assert/strict";

import {
  HistorianSemanticAdapterRegistry,
  processingProfileIdOf,
  SemanticAdapterConflictError,
  SemanticAdapterMutationError,
  type SemanticAdapter,
} from "../src/historian/semantic-adapter-registry.js";
import type { MemoryObservationV1 } from "../src/contracts/memory-publication.js";
import { STUB_LINEAGE_ID, fixtureUnit } from "./helpers/historian-context-stub.js";

function observation(): MemoryObservationV1 {
  return {
    schemaId: "iris.memory_observation.v1",
    observationId: "obs-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 1,
    rangeHash: "rh",
    semanticSchemaId: "reasoning",
    statement: "hello",
    semanticKind: "reasoning",
    attributionClass: "iris_decision",
    sourceTrust: "generated",
    referenceTime: "2026-08-01T00:00:00.000Z",
    evidenceBasis: [],
    derivedOnly: false,
  };
}

test("adapter registry: ownership conflict on the same schemaId fails closed", () => {
  const registry = new HistorianSemanticAdapterRegistry();
  const a: SemanticAdapter = { schemaIds: ["reasoning"], version: "1.0.0" };
  const b: SemanticAdapter = { schemaIds: ["reasoning"], version: "2.0.0" };
  registry.registerAdapter(a);
  assert.throws(() => {
    registry.registerAdapter(b);
  }, SemanticAdapterConflictError);
  assert.equal(registry.getAdapter("reasoning"), a, "first owner retained");
  assert.equal(registry.owns("reasoning"), true);
  assert.equal(registry.owns("unknown"), false);
});

test("adapter registry: frozen profile is a deterministic hash of the adapter version set", () => {
  const registry = new HistorianSemanticAdapterRegistry();
  assert.equal(
    registry.frozenProcessingProfile().profileId,
    processingProfileIdOf([]),
    "empty profile",
  );
  registry.registerAdapter({ schemaIds: ["reasoning"], version: "1.0.0" });
  registry.registerAdapter({ schemaIds: ["dialogue", "tool_result"], version: "2.0.0" });
  const profile = registry.frozenProcessingProfile();
  assert.ok(profile.profileId.length > 0);
  assert.equal(profile.adapters.length, 2);
  const again = new HistorianSemanticAdapterRegistry();
  again.registerAdapter({ schemaIds: ["reasoning"], version: "1.0.0" });
  again.registerAdapter({ schemaIds: ["dialogue", "tool_result"], version: "2.0.0" });
  assert.equal(
    again.frozenProcessingProfile().profileId,
    profile.profileId,
    "deterministic across registries",
  );
  // adapter 版本变化 → profile 变化（只影响后续 batch）。
  const v3 = new HistorianSemanticAdapterRegistry();
  v3.registerAdapter({ schemaIds: ["reasoning"], version: "1.1.0" });
  v3.registerAdapter({ schemaIds: ["dialogue", "tool_result"], version: "2.0.0" });
  assert.notEqual(
    v3.frozenProcessingProfile().profileId,
    profile.profileId,
    "version change → new profile",
  );
});

test("adapter registry: frozen profile recorded at claim; registration order is irrelevant", () => {
  const r1 = new HistorianSemanticAdapterRegistry();
  r1.registerAdapter({ schemaIds: ["dialogue"], version: "1.0.0" });
  r1.registerAdapter({ schemaIds: ["reasoning"], version: "1.0.0" });
  const r2 = new HistorianSemanticAdapterRegistry();
  r2.registerAdapter({ schemaIds: ["reasoning"], version: "1.0.0" });
  r2.registerAdapter({ schemaIds: ["dialogue"], version: "1.0.0" });
  assert.equal(r1.frozenProcessingProfile().profileId, r2.frozenProcessingProfile().profileId);
});

test("adapter registry: interpret only runs for the owner's own schema", () => {
  const registry = new HistorianSemanticAdapterRegistry();
  const unit = fixtureUnit({
    contextSeq: 1,
    kind: "assistant",
    semanticSchemaId: "iris.semantic.context_message.assistant.v1",
    semanticContent: { role: "assistant", content: "x" },
  });
  const obs = observation();
  // No owner → undefined (not an error).
  assert.equal(registry.invokeInterpret({ unit, observation: obs }), undefined);

  const calls: string[] = [];
  registry.registerAdapter({
    schemaIds: ["reasoning"],
    version: "1.0.0",
    interpret(input) {
      calls.push(input.observation.semanticKind);
      return { annotation: { kind: "summary" } };
    },
  });
  const result = registry.invokeInterpret({ unit, observation: obs });
  assert.deepEqual(result?.annotation, { kind: "summary" });
  assert.deepEqual(calls, ["reasoning"], "interpret invoked for owned schema");
  // 非 owner schema 的 observation 不会被解释。
  const other = { ...obs, semanticSchemaId: "dialogue" };
  assert.equal(registry.invokeInterpret({ unit, observation: other }), undefined);
});

test("adapter registry: interpret must not mutate its input (fail closed)", () => {
  const registry = new HistorianSemanticAdapterRegistry();
  registry.registerAdapter({
    schemaIds: ["reasoning"],
    version: "1.0.0",
    interpret(input) {
      // 恶意/错误 adapter 试图修改 provenance/basis。
      input.observation.derivedOnly = true;
      input.observation.evidenceBasis.push({
        schemaId: "iris.evidence_basis_ref.v1",
        contextLineageId: STUB_LINEAGE_ID,
        contextUnitId: "unit-x",
        contextSeq: 99,
        runtimeEventId: "e",
        contentHash: "h",
        historianDisposition: "include",
      });
      return { annotation: "x" };
    },
  });
  const unit = fixtureUnit({
    contextSeq: 1,
    kind: "assistant",
    semanticSchemaId: "iris.semantic.context_message.assistant.v1",
    semanticContent: { role: "assistant", content: "x" },
  });
  assert.throws(
    () => registry.invokeInterpret({ unit, observation: observation() }),
    SemanticAdapterMutationError,
  );
});

test("adapter registry: registry itself is pure in-memory (no persistence contract)", () => {
  const registry = new HistorianSemanticAdapterRegistry();
  const adapter: SemanticAdapter = { schemaIds: ["a"], version: "1.0.0" };
  registry.registerAdapter(adapter);
  // 同一实例重复注册同一 adapter 是幂等的（不冲突）。
  registry.registerAdapter(adapter);
  assert.equal(registry.getAdapter("a"), adapter);
  // 全新对象（即使字段相同）是不同 adapter → 冲突 fail-closed。
  assert.throws(() => {
    registry.registerAdapter({ schemaIds: ["a"], version: "1.0.0" });
  }, SemanticAdapterConflictError);
});
