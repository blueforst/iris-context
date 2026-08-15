/**
 * Feature 6 + Feature 2（iris-context#2/#5）：legacy dual-DTO path 敏感度门
 * （sensitivity gate）。
 *
 * 权威要求（iris-context#2 AC + #5 AC + 任务 §21）：
 *   - 如果重新引入 `ContextMessageUnit` / `ContextUnitV2` / `ContextGenerationV2`
 *     / `CanonicalRuntimeEventV1` / 旧 P0–P4 pre-projection DTO 路径
 *     （`P0P1P2P3P4Unit` / `buildContextGenerationV2` / `projectP5Unit`）作为
 *     正常生产路径类型，CI 必须失败；
 *   - legacy / fixtures / migrations 可窄 allowlist；
 *   - 正常公共领域代码使用无版本类型名（`ContextUnit` / `ContextGeneration`）；
 *     生成式 `ContextUnitV3` / `ContextGenerationV3` 只作为 wire/schema 实现细节
 *     或显式 compat/schema export（src/contracts/context-unit.ts 领域 shim）。
 *
 * 本门扫描 src 目录下所有 .ts 文件：旧 DTO 类型名（精确词边界，不会误伤
 * `sourceContextMessageUnitIds` 字段名）只能出现在明确 allowlisted 的 legacy
 * 文件（旧 contracts shim、legacy ingest 模块、legacy 读兼容路径、显式 legacy
 * builder）。
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/** 旧双 DTO / 旧 pre-projection 路径的类型名（精确词边界；字段名 sourceContextMessageUnitIds 不匹配）。 */
const LEGACY_TYPE_TOKENS: RegExp[] = [
  /\bContextMessageUnitV1\b/,
  /\bContextMessageUnit\b(?!Ids)/,
  /\bContextUnitV2\b/,
  /\bContextGenerationV2\b/,
  /\bCanonicalRuntimeEventV1\b/,
  // ContextUnitHeaderV1 是旧 generation-unit header（仅 legacy V2 双 DTO 路径
  // 使用）；ContextGenerationHeaderV1 不列入 —— 它是共享 wire header
  // （iris.context_generation_header.v1，当前 ContextGeneration 也使用）。
  /\bContextUnitHeaderV1\b/,
  // iris-context#5：旧 P0–P4 pre-projection DTO 路径（正常路径不得再出现）。
  /\bP0P1P2P3P4Unit\b/,
  /\bbuildContextGenerationV2\b/,
  /\bprojectP5Unit\b/,
];

/** 生成式 *V3 wire 类型名 —— 正常公共领域代码必须用无版本别名。 */
const V3_WIRE_TYPE_TOKENS: RegExp[] = [/\bContextUnitV3\b/, /\bContextGenerationV3\b/];

/**
 * 窄 allowlist：这些文件是明确的 legacy/migration 载体（旧 contracts shim、
 * legacy ingest、legacy 读兼容、显式 legacy builder）。它们保留旧类型作为
 * 迁移/审计输入，但绝不能成为新正常路径。
 */
const LEGACY_FILES_ALLOWLIST = new Set([
  "src/contracts/context-v27.ts",
  "src/contracts/context-units.ts",
  "src/contracts/runtime-events.ts",
  "src/contracts/context.ts",
  "src/context/context-ingest.ts",
  "src/context/context-store.ts",
  "src/context/legacy/generation-builder-v2.ts",
]);

/**
 * 生成式 *V3 wire 类型名的窄 allowlist：只有领域契约 shim（定义无版本别名
 * 与 schemaId 的公共出口）允许直接引用生成式 wire 类型名。正常生产代码必须
 * 经 `ContextUnit` / `ContextGeneration` 无版本名称消费。
 */
const V3_WIRE_ALLOWLIST = new Set(["src/contracts/context-unit.ts"]);

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function collectOffenders(
  tokenPatterns: RegExp[],
  allowlist: Set<string>,
): Array<{ file: string; token: RegExp }> {
  const offenders: Array<{ file: string; token: RegExp }> = [];
  const tsFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
  for (const f of tsFiles) {
    const relative = path.relative(REPO_ROOT, f).replace(/\\/g, "/");
    if (allowlist.has(relative)) {
      continue;
    }
    const code = stripComments(fs.readFileSync(f, "utf8"));
    for (const token of tokenPatterns) {
      if (token.test(code)) {
        offenders.push({ file: relative, token });
      }
    }
  }
  return offenders;
}

test("F6/F2: legacy dual-DTO / pre-projection names appear only in the narrow legacy allowlist", () => {
  const offenders = collectOffenders(LEGACY_TYPE_TOKENS, LEGACY_FILES_ALLOWLIST);
  assert.deepEqual(
    offenders.map((o) => `${o.file} uses ${o.token}`),
    [],
    "legacy dual-DTO / P0–P4 pre-projection names must NOT appear outside the narrow legacy " +
      "allowlist (reintroducing ContextMessageUnit/ContextUnitV2/ContextGenerationV2/" +
      "P0P1P2P3P4Unit as a normal production path must fail CI)",
  );
});

test("F2: generated *V3 wire type names appear only in the domain contracts shim", () => {
  const offenders = collectOffenders(V3_WIRE_TYPE_TOKENS, V3_WIRE_ALLOWLIST);
  assert.deepEqual(
    offenders.map((o) => `${o.file} uses ${o.token}`),
    [],
    "current public domain code must use the unversioned ContextUnit / ContextGeneration " +
      "names; generated ContextUnitV3 / ContextGenerationV3 are wire/schema implementation " +
      "details or explicit compat/schema exports only (src/contracts/context-unit.ts)",
  );
});

test("F2: current generation-builder path is V2-free (single ContextUnit model)", () => {
  const builderPath = path.join(SRC_DIR, "context", "generation-builder.ts");
  const code = stripComments(fs.readFileSync(builderPath, "utf8"));
  for (const token of [
    /ContextMessageUnit/,
    /ContextUnitV2/,
    /ContextGenerationV2/,
    /P0P1P2P3P4Unit/,
    /buildContextGenerationV2/,
    /projectP5Unit/,
  ]) {
    assert.doesNotMatch(
      code,
      token,
      `current generation-builder.ts must not reference legacy V2 dual-DTO path (${token})`,
    );
  }
});
