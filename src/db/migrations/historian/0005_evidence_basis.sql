-- R3 (iris_agent#9) — persist anti-echo classification on evidence_sets.
--
-- EvidenceSet 携带 evidenceBasis(仅 include 且非 derived-only 的 Context
-- 单元)与 derivedOnly 标记;落库使 Exit Gate 3 可审计、可被 Publication
-- 载荷与 assessment 消费。forward-only;旧行两列默认 NULL(= 旧行为,
-- 不伪造分类)。
ALTER TABLE evidence_sets ADD COLUMN evidence_basis_json TEXT;
ALTER TABLE evidence_sets ADD COLUMN derived_only INTEGER;
