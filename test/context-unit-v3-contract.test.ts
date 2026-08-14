/**
 * Feature 1（iris-context#2）：ContextUnit v3 契约测试。
 *
 * 覆盖：
 *  - schema 身份裁决：新统一 ContextUnit = `iris.context_unit.v3`；旧
 *    `iris.context_unit.v1` / `iris.context_unit.v2` 只允许出现在 legacy/
 *    migration fixture（schema ID 复用 gate）；
 *  - ContextUnit 领域类型（无版本后缀）与生成式 ContextUnitV3 的映射；
 *  - DshMessageRef / ContextUnitSourceRef 判别守卫与严格解析（fail-closed）；
 *  - canonical content hash 确定性（键序无关）与 tamper 检测；
 *  - 确定性 unitId 派生（rebuild 不产生随机新 identity）；
 *  - 生成式 v3 fixture 校验通过；v1/v2 legacy fixture 被 v3 校验拒绝。
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

import {
  CONTEXT_UNIT_V3_SCHEMA_ID,
  DSH_MESSAGE_REF_V1_SCHEMA_ID,
  computeContextUnitContentHash,
  deriveContextUnitId,
  isDshMessageRef,
  isGenericSourceRef,
  parseContextUnitSourceRef,
  validateContextUnitStrict,
  type ContextUnit,
  type DshMessageRef,
} from "../src/contracts/context-unit.js";
import {
  IRIS_CONTEXT_UNIT_V2_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_V3_SCHEMA_ID as IRIS_V3,
} from "../contracts/generated/types.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// 旧 flat v1 schemaId：历史 fixture 专用（当前 registry 无此 schema，故从
// fixture 断言，而非生成常量）。
const LEGACY_CONTEXT_UNIT_V1_SCHEMA_ID = "iris.context_unit.v1";

/** 读取 JSON fixture（typed：解析结果按 unknown 处理，避免 any）。 */
function readJsonFixture(relativePath: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "contracts/generated/migration-fixtures", relativePath),
      "utf8",
    ),
  ) as unknown;
}

function readJsonFile(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")) as unknown;
}

// ---------------------------------------------------------------------------
// 构造 helper
// ---------------------------------------------------------------------------

function makeUnit(overrides: Record<string, unknown> = {}): ContextUnit {
  const sourceRef: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "sess-1",
    messageId: "msg-1",
    eventSeq: 5,
  };
  const base = {
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: "unit-test-1",
    contextId: "lineage-test",
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content: "hello world" },
    sourceRef,
  };
  const contentHash = computeContextUnitContentHash({
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: base.unitId,
    contextId: base.contextId,
    contentSchemaId: base.contentSchemaId,
    content: base.content,
    sourceRef,
  });
  return { ...base, contentHash, ...overrides } as ContextUnit;
}

// ---------------------------------------------------------------------------
// schema 身份裁决 / 复用 gate
// ---------------------------------------------------------------------------

test("F1: unified ContextUnit allocates iris.context_unit.v3 (not v1/v2)", () => {
  assert.equal(CONTEXT_UNIT_V3_SCHEMA_ID, "iris.context_unit.v3");
  // 旧 schema 身份已被历史真实使用（flat v1 / structured v2），不得复用。
  assert.notEqual(CONTEXT_UNIT_V3_SCHEMA_ID, LEGACY_CONTEXT_UNIT_V1_SCHEMA_ID);
  assert.notEqual(CONTEXT_UNIT_V3_SCHEMA_ID, IRIS_CONTEXT_UNIT_V2_SCHEMA_ID);
});

test("F1: v1/v2 schema identities exist ONLY as legacy constants, not as current schema", () => {
  const source = readJsonFile("contracts/source/schemas.json") as {
    schemas: Record<string, unknown>;
  };
  const schemaIds = Object.keys(source.schemas);
  assert.ok(!schemaIds.includes("iris.context_unit.v1"), "v1 must not be a current schema");
  assert.ok(schemaIds.includes("iris.context_unit.v3"), "v3 must be the current schema");
  // v2 在 Feature 1–3 迁移期间仍被现有生产代码使用（generation-builder 直到
  // Feature 3 才迁移）；Feature 6 的 sensitivity gate 将证明 v2 最终退出
  // 当前 schema 集。
  assert.ok(schemaIds.includes("iris.context_unit.v2"), "v2 remains in use during migration");
  // legacy fixture 目录仍保留 v1/v2 作为 migration/compat 输入。
  const fixtureDir = path.join(REPO_ROOT, "contracts/generated/migration-fixtures");
  assert.ok(fs.existsSync(path.join(fixtureDir, "v1-flat-unit.fixture.json")));
  assert.ok(fs.existsSync(path.join(fixtureDir, "v2-generation.fixture.json")));
  assert.ok(fs.existsSync(path.join(fixtureDir, "v3-unit.fixture.json")));
  assert.ok(fs.existsSync(path.join(fixtureDir, "v3-generation.fixture.json")));
});

// ---------------------------------------------------------------------------
// 判别守卫 / 严格解析
// ---------------------------------------------------------------------------

test("F1: isDshMessageRef distinguishes runtime-origin source", () => {
  const ref: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "s",
    messageId: "m",
  };
  assert.ok(isDshMessageRef(ref));
  assert.ok(
    !isDshMessageRef({
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "x",
      sourceId: "y",
      sourceHash: "z",
    }),
  );
  assert.ok(!isDshMessageRef(null));
  assert.ok(
    !isDshMessageRef({ schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "", messageId: "m" }),
  );
});

test("F1: parseContextUnitSourceRef accepts both ref shapes and rejects everything else", () => {
  const dsh = parseContextUnitSourceRef({
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "s",
    messageId: "m",
  });
  assert.ok(isDshMessageRef(dsh));
  const generic = parseContextUnitSourceRef({
    schemaId: "iris.context_unit_source_ref.v1",
    sourceSchemaId: "iris.system_prompt.v1",
    sourceId: "sp-1",
    sourceHash: "abc",
  });
  assert.ok(isGenericSourceRef(generic));
  for (const bad of [
    null,
    42,
    "x",
    {},
    { schemaId: "bogus" },
    { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID },
  ]) {
    assert.throws(() => parseContextUnitSourceRef(bad), /sourceRef/);
  }
});

// ---------------------------------------------------------------------------
// canonical content hash
// ---------------------------------------------------------------------------

test("F1: computeContextUnitContentHash is canonical (key-order independent)", () => {
  const ref: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "s",
    messageId: "m",
  };
  const h1 = computeContextUnitContentHash({
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: "u",
    contextId: "c",
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content: "x" },
    sourceRef: ref,
  });
  const h2 = computeContextUnitContentHash({
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: "u",
    contextId: "c",
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { content: "x", role: "user" }, // 键序不同
    sourceRef: ref,
  });
  assert.equal(h1, h2);
});

test("F1: contentHash changes when any immutable field changes", () => {
  const unit = makeUnit();
  const hash = unit.contentHash;
  const variants: Array<Record<string, unknown>> = [
    { content: { role: "user", content: "hello world!" } },
    { contentSchemaId: "iris.semantic.context_message.assistant.v1" },
    { unitId: "unit-other" },
    { contextId: "lineage-other" },
    {
      sourceRef: {
        schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
        sessionId: "sess-1",
        messageId: "msg-2",
      },
    },
  ];
  for (const variant of variants) {
    const contentHash = computeContextUnitContentHash({
      schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
      unitId: (variant["unitId"] as string) ?? unit.unitId,
      contextId: (variant["contextId"] as string) ?? unit.contextId,
      contentSchemaId: (variant["contentSchemaId"] as string) ?? unit.contentSchemaId,
      content: (variant["content"] as { role: string; content: string }) ?? unit.content,
      sourceRef: (variant["sourceRef"] as DshMessageRef) ?? unit.sourceRef,
    });
    assert.notEqual(contentHash, hash);
  }
});

// ---------------------------------------------------------------------------
// 确定性 unitId 派生
// ---------------------------------------------------------------------------

test("F1: deriveContextUnitId is deterministic and excludes eventSeq from identity", () => {
  const refA: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "s",
    messageId: "m",
    eventSeq: 3,
  };
  const refB: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: "s",
    messageId: "m",
    eventSeq: 99,
  };
  assert.equal(deriveContextUnitId("c", refA), deriveContextUnitId("c", refB));
  assert.notEqual(deriveContextUnitId("c", refA), deriveContextUnitId("c2", refA));
  const generic = parseContextUnitSourceRef({
    schemaId: "iris.context_unit_source_ref.v1",
    sourceSchemaId: "iris.system_prompt.v1",
    sourceId: "sp-1",
    sourceHash: "abc",
  });
  assert.equal(deriveContextUnitId("c", generic), deriveContextUnitId("c", generic));
});

// ---------------------------------------------------------------------------
// 严格校验
// ---------------------------------------------------------------------------

test("F1: validateContextUnitStrict passes on a valid unit", () => {
  const unit = makeUnit();
  const check = validateContextUnitStrict(unit);
  assert.equal(check.valid, true, check.reason);
});

test("F1: validateContextUnitStrict rejects legacy v1/v2 schema IDs", () => {
  const v1 = {
    schemaId: "iris.context_unit.v1",
    unitId: "u",
    contextId: "c",
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content: "x" },
    contentHash: "h",
    sourceRef: {},
  };
  const v2 = { schemaId: "iris.context_unit.v2", header: {}, semanticContent: {} };
  assert.ok(!validateContextUnitStrict(v1).valid);
  assert.ok(!validateContextUnitStrict(v2).valid);
});

test("F1: validateContextUnitStrict rejects unknown semantic schema and tampered hash", () => {
  const badSchema = makeUnit({ contentSchemaId: "iris.semantic.totally_unknown.v999" });
  const r1 = validateContextUnitStrict(badSchema);
  assert.ok(!r1.valid);
  assert.match(r1.reason ?? "", /unknown semanticSchemaId/);

  const tampered = makeUnit({ content: { role: "user", content: "tampered!" } }); // hash 未更新
  const r2 = validateContextUnitStrict(tampered);
  assert.ok(!r2.valid);
  assert.match(r2.reason ?? "", /contentHash mismatch/);
});

test("F1: validateContextUnitStrict rejects malformed sourceRef", () => {
  const bad = makeUnit({ sourceRef: { schemaId: "bogus", foo: 1 } });
  const check = validateContextUnitStrict(bad);
  assert.ok(!check.valid);
  assert.match(check.reason ?? "", /sourceRef/);
});

test("F1: validateContextUnitStrict rejects optional-field type violations in sourceRef (regression)", () => {
  // DshMessageRefV1.eventSeq 必须是 integer >= 0（review finding 回归测试）。
  const badEventSeq = makeUnit({
    sourceRef: {
      schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
      sessionId: "s",
      messageId: "m",
      eventSeq: "not-a-number",
    },
  });
  const r1 = validateContextUnitStrict(badEventSeq);
  assert.ok(!r1.valid, "eventSeq as string must fail closed");
  assert.match(r1.reason ?? "", /DshMessageRef/);

  // 通用 sourceRef 携带未知键 → 生成式 schema（additionalProperties=false）拒绝。
  const badKey = makeUnit({
    sourceRef: {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "iris.system_prompt.v1",
      sourceId: "sp-1",
      sourceHash: "abc",
      bogus: 42,
    },
  });
  const r2 = validateContextUnitStrict(badKey);
  assert.ok(!r2.valid, "sourceRef unknown key must fail closed");
  assert.match(r2.reason ?? "", /ContextUnitSourceRefV1/);
});

test("F1: validateContextUnitStrict rejects derivation unknown keys (regression)", () => {
  const badDerivation = makeUnit({
    derivation: {
      schemaId: "iris.semantic_derivation_refs.v1",
      sourceContextMessageUnitIds: ["u-1"],
      bogus: "x",
    },
  });
  const check = validateContextUnitStrict(badDerivation);
  assert.ok(!check.valid, "derivation unknown key must fail closed");
  assert.match(check.reason ?? "", /derivation/);

  // 合法 immutable basis 应通过（derivation 参与 contentHash，需重算）。
  const goodUnit = makeUnit({
    derivation: {
      schemaId: "iris.semantic_derivation_refs.v1",
      sourceContextMessageUnitIds: ["u-1"],
    },
  }) as ContextUnit;
  const recomputedHash = computeContextUnitContentHash({
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: goodUnit.unitId,
    contextId: goodUnit.contextId,
    contentSchemaId: goodUnit.contentSchemaId,
    content: goodUnit.content,
    sourceRef: goodUnit.sourceRef,
    ...(goodUnit.derivation !== undefined ? { derivation: goodUnit.derivation } : {}),
  });
  const check2 = validateContextUnitStrict({ ...goodUnit, contentHash: recomputedHash });
  assert.equal(check2.valid, true, check2.reason);
});

test("F1: validateContextUnitStrict enforces header/payload separation (no lifecycle/ordering fields)", () => {
  // Unit 本体禁止携带 lifecycle/ordering/表示状态（sidecar 之外）。
  const withSeq = makeUnit({ contextSeq: 7 } as unknown as Record<string, unknown>);
  const check = validateContextUnitStrict(withSeq);
  assert.ok(!check.valid, "contextSeq is a sidecar ordering coordinate, not a ContextUnit field");
  assert.match(check.reason ?? "", /unknown key/);

  // canonical hash 不覆盖 sidecar 字段（hash basis 只含 immutable 字段）。
  const unit = makeUnit();
  const hashWithoutSeq = computeContextUnitContentHash({
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: unit.unitId,
    contextId: unit.contextId,
    contentSchemaId: unit.contentSchemaId,
    content: unit.content,
    sourceRef: unit.sourceRef,
  });
  assert.equal(hashWithoutSeq, unit.contentHash);
});

// ---------------------------------------------------------------------------
// 生成式 fixtures
// ---------------------------------------------------------------------------

test("F1: generated v3-unit fixture validates; v1/v2 fixtures rejected", () => {
  const v3 = readJsonFixture("v3-unit.fixture.json");
  assert.equal(validateContextUnitStrict(v3).valid, true);

  const v1 = readJsonFixture("v1-flat-unit.fixture.json");
  assert.ok(!validateContextUnitStrict(v1).valid, "flat v1 unit must be rejected by v3 contract");

  const v2 = readJsonFixture("v2-generation.fixture.json");
  assert.ok(
    !validateContextUnitStrict(v2).valid,
    "v2 generation member must be rejected by v3 contract",
  );
});

test("F1: generated v3-generation fixture is present and references v3 units", () => {
  const v3Gen = readJsonFixture("v3-generation.fixture.json") as {
    schemaId: string;
    units: Array<{ schemaId: string; sourceRef: { schemaId: string } }>;
  };
  assert.equal(v3Gen.schemaId, "iris.context_generation.v3");
  assert.equal(v3Gen.units.length, 1);
  const unit = v3Gen.units[0];
  assert.ok(unit !== undefined);
  assert.equal(unit.schemaId, "iris.context_unit.v3");
  assert.equal(unit.sourceRef.schemaId, DSH_MESSAGE_REF_V1_SCHEMA_ID);
});

// ---------------------------------------------------------------------------
// 领域类型名（无版本后缀）映射
// ---------------------------------------------------------------------------

test("F1: domain type ContextUnit maps to generated ContextUnitV3 wire schema", () => {
  const unit = makeUnit();
  assert.equal(unit.schemaId, "iris.context_unit.v3");
  assert.equal(unit.contentHash.length, 64);
  assert.equal(unit.sourceRef.schemaId, DSH_MESSAGE_REF_V1_SCHEMA_ID);
  // IRIS_V3 常量与领域 shim 一致
  assert.equal(IRIS_V3, CONTEXT_UNIT_V3_SCHEMA_ID);
});
