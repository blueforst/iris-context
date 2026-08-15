/**
 * Feature 6（iris-context#2）：legacy dual-DTO path 敏感度门（sensitivity gate）。
 *
 * 权威要求（iris-context#2 AC + 任务 §21）：
 *   - 如果重新引入 `ContextMessageUnit` / `ContextUnitV2` / `CanonicalRuntimeEventV1`
 *     （以及对应的生成式类型名）作为正常生产路径类型，CI 必须失败；
 *   - legacy / fixtures / migrations 可窄 allowlist。
 *
 * 本门扫描 src 目录下所有 .ts 文件：旧 DTO 类型名（精确词边界，不会误伤
 * `sourceContextMessageUnitIds` 字段名）只能出现在明确 allowlisted 的 legacy
 * 文件（旧 contracts shim、legacy ingest 模块、legacy 读兼容路径、v2 builder）。
 */
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/** 旧双 DTO 路径的类型名（精确词边界；字段名 sourceContextMessageUnitIds 不匹配）。 */
const LEGACY_TYPE_TOKENS: RegExp[] = [
  /\bContextMessageUnitV1\b/,
  /\bContextMessageUnit\b(?!Ids)/,
  /\bContextUnitV2\b/,
  /\bContextGenerationV2\b/,
  /\bCanonicalRuntimeEventV1\b/,
  /\bContextUnitHeaderV1\b/,
  /\bContextGenerationHeaderV1\b/,
];

/**
 * 窄 allowlist：这些文件是明确的 legacy/migration 载体（旧 contracts shim、
 * legacy ingest、legacy 读兼容、v2 builder）。它们保留旧类型作为迁移/审计输入，
 * 但绝不能成为新正常路径。
 */
const LEGACY_FILES_ALLOWLIST = new Set([
  "src/contracts/context-v27.ts",
  "src/contracts/context-units.ts",
  "src/contracts/runtime-events.ts",
  "src/contracts/context.ts",
  "src/context/context-ingest.ts",
  "src/context/context-store.ts",
  "src/context/generation-builder.ts",
]);

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

test("F6: legacy dual-DTO type names appear only in the narrow legacy allowlist", () => {
  const tsFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
  const offenders: string[] = [];
  for (const f of tsFiles) {
    const relative = path.relative(REPO_ROOT, f).replace(/\\/g, "/");
    if (LEGACY_FILES_ALLOWLIST.has(relative)) {
      continue;
    }
    const code = stripComments(fs.readFileSync(f, "utf8"));
    for (const token of LEGACY_TYPE_TOKENS) {
      if (token.test(code)) {
        offenders.push(`${relative} uses legacy DTO type matching ${token}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "legacy dual-DTO type names must NOT appear outside the narrow legacy allowlist " +
      "(reintroducing ContextMessageUnit/ContextUnitV2/CanonicalRuntimeEventV1 as a " +
      "normal production path must fail CI)",
  );
});
