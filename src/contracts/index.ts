/**
 * contracts 公共入口（barrel）—— 统一 ContextUnit 生命周期的公共 API 面
 * （iris-context#2 Feature 6：公共 API 收敛）。
 *
 * 权威来源（2026-08-15 Notion override + iris-context#2）：
 *   - semantic source → Context admission → ContextUnit exactly once；
 *   - 消费方（iris_agent 等）经本入口获得：领域类型（ContextUnit/
 *     ContextUnitSourceRef/DshMessageRef/ContextGenerationV3）、纯函数
 *     （materializeContextUnit/deriveContextUnitId/computeContextUnitContentHash/
 *     validateContextUnitStrict）、以及 ContextAdmission 接纳边界服务；
 *   - `./contracts/context-unit` 子路径仍可直接指向 context-unit.js；
 *   - `./contracts/legacy` 是唯一保留旧 v27 DTO 的入口（legacy shim）。
 *
 * 本 barrel 是 contracts 层的组装点：`export *` 来自 context-unit.js（领域契约
 * shim），admission 符号显式 re-export 自 context 层（接纳边界）。不新增实现。
 */

export * from "./context-unit.js";
export {
  ContextAdmission,
  materializeContextUnit,
  sourceAnchorOf,
  dshSourceAnchor,
  genericSourceAnchor,
  type AdmitSourceInput,
  type AdmissionCandidate,
} from "../context/context-admission.js";
