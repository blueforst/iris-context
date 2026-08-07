/**
 * R3 (iris_agent#9) — hot-row reclaim 纯逻辑层(Exit Gate 4)。
 *
 * active historian.db 的有界性:compartment 相关 hot rows 仅在满足全部
 * 四条件后才释放:
 *   1. context_ack         — Context 侧确认该范围;
 *   2. bust_represented    — Context bust retirement 已覆盖该范围;
 *   3. memory_durable_ack  — iris_memory 已 durable 接受对应 Publication;
 *   4. shard_verified      — archive shard seal hash 已验证。
 *
 * 本模块是 PURE 层(无 I/O):判定条件是否满足、计算可释放集合、生成 shard
 * seal 的确定性内容。持久化与删除由 HistorianStore 负责。
 */

/** 释放条件跟踪的纯视图(values-only)。 */
export interface CompartmentReleaseView {
  compartmentId: string;
  runtimeSessionId: string;
  compartmentSequence: number;
  startEntrySeq: number;
  endEntrySeq: number;
  publicationSequence: number | null;
  contextAckedAt: string | null;
  bustRepresentedAt: string | null;
  memoryDurableAckAt: string | null;
  memoryReceiptHash: string | null;
  /**
   * iris_agent#64:markDelivered 持久化的**已验证绑定 receipt** —— reclaim
   * 授权必须看到绑定身份(publicationId + canonicalPayloadHash +
   * contractVersion),不能只凭裸 opaque 字符串。
   */
  deliveredReceiptId: string | null;
  deliveredReceiptPublicationId: string | null;
  deliveredCanonicalPayloadHash: string | null;
  deliveredContractVersion: string | null;
  shardId: string | null;
  shardVerifiedAt: string | null;
  reclaimedAt: string | null;
}

/**
 * 四条件是否全部满足(纯判定)。
 * - contextAck / bustRepresented / memoryDurableAck 必须有时间戳;
 * - 已验证的绑定 receipt 必须存在(iris_agent#64:receiptId +
 *   receiptPublicationId + canonicalPayloadHash + contractVersion 全部
 *   持久化 —— 裸 hash 或空绑定不足以授权);
 * - shardVerifiedAt 必须有时间戳。
 * 任何条件缺失 → 不释放(fail-closed:宁可保留 hot rows,绝不提前释放)。
 */
export function isReclaimEligible(view: CompartmentReleaseView): boolean {
  return (
    view.contextAckedAt !== null &&
    view.bustRepresentedAt !== null &&
    view.memoryDurableAckAt !== null &&
    view.deliveredReceiptId !== null &&
    view.deliveredReceiptId.length > 0 &&
    view.deliveredReceiptPublicationId !== null &&
    view.deliveredReceiptPublicationId.length > 0 &&
    view.deliveredCanonicalPayloadHash !== null &&
    view.deliveredCanonicalPayloadHash.length > 0 &&
    view.deliveredContractVersion !== null &&
    view.deliveredContractVersion.length > 0 &&
    view.shardVerifiedAt !== null &&
    view.reclaimedAt === null
  );
}

/** 从全部视图筛选可释放集合(确定性:按 compartmentSequence 升序)。 */
export function eligibleForReclaim(views: CompartmentReleaseView[]): CompartmentReleaseView[] {
  return views
    .filter(isReclaimEligible)
    .sort((a, b) => a.compartmentSequence - b.compartmentSequence);
}

/** 记录 ACK(纯函数:返回带时间戳的新视图)。 */
export function withContextAck(view: CompartmentReleaseView, at: string): CompartmentReleaseView {
  return { ...view, contextAckedAt: at };
}

export function withBustRepresented(
  view: CompartmentReleaseView,
  at: string,
): CompartmentReleaseView {
  return { ...view, bustRepresentedAt: at };
}

export function withMemoryDurableAck(
  view: CompartmentReleaseView,
  at: string,
  receiptHash: string,
): CompartmentReleaseView {
  return { ...view, memoryDurableAckAt: at, memoryReceiptHash: receiptHash };
}

export function withShardVerified(
  view: CompartmentReleaseView,
  shardId: string,
  at: string,
): CompartmentReleaseView {
  return { ...view, shardId, shardVerifiedAt: at };
}

/** 生成 shard seal 的确定性内容(纯):按序列号排序的行视图 → 规范 JSON。 */
export function sealShardContent(
  sessionId: string,
  views: CompartmentReleaseView[],
  rowCount: number,
): string {
  const sorted = [...views].sort((a, b) => a.compartmentSequence - b.compartmentSequence);
  const payload = {
    schemaVersion: "historian-shard-v1",
    runtimeSessionId: sessionId,
    compartments: sorted.map((v) => ({
      compartmentId: v.compartmentId,
      compartmentSequence: v.compartmentSequence,
      startEntrySeq: v.startEntrySeq,
      endEntrySeq: v.endEntrySeq,
      publicationSequence: v.publicationSequence,
      memoryReceiptHash: v.memoryReceiptHash,
    })),
    rowCount,
  };
  // 确定性:键排序 + 紧凑分隔符。replacer 数组会过滤嵌套 keys,故手动
  // 按 key 排序后序列化。
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    canonical[key] = (payload as Record<string, unknown>)[key];
  }
  return JSON.stringify(canonical);
}

/**
 * shard id 派生(纯):session + 首个 compartment 序列 → 稳定 id。
 */
export function deriveShardId(sessionId: string, firstCompartmentSequence: number): string {
  return `shard-${sessionId}-${firstCompartmentSequence}`;
}
