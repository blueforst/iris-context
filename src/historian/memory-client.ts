/**
 * R4 (iris_agent#9) — Memory Client(投递 Historian publication 到 iris_memory)。
 *
 * 边界(v13 + 三项目边界):Agent 只通过本客户端投递 outbox 中的
 * historian-publication-v2 envelope 并接收 acceptance receipt;不读取
 * iris_memory 数据库、不连接 Neo4j、不实现 stable memoryRef。
 *
 * 投递语义(iris_agent#64 精确绑定):
 *  - 200 + acceptance-receipt-v1 → 验证 receipt 绑定身份(publicationId 与
 *    请求一致、canonicalPayloadHash 与本地重算一致、contractVersion 与
 *    请求一致、schemaVersion/status 为契约常量)后 delivered;
 *  - 200 + duplicate-replay-receipt-v1 → 同样的绑定验证(idempotency 重放
 *    安全:同 publicationId + 同 canonical hash 的确定性重复回执)后 delivered;
 *  - 409 idempotency/sequence conflict → **失败**:同 idempotencyKey 但内容
 *    不同(或 sequence 乱序)是错误信号,绝不视为 delivered;
 *  - 400 validation / 422 unsupported → quarantined(永不重试噪声);
 *  - 网络失败/5xx/timeout → retry_wait(由 outbox 退避重试);
 *  - 响应缺失绑定身份或身份不匹配 → fail closed(裸/错位 receipt 不可用)。
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../contracts/tool.js";
import type {
  MemoryAcceptanceReceipt,
  MemoryClientPort,
  PublicationDeliveryOutcome,
} from "../contracts/ports.js";

/** iris_agent#64:本地重算 canonical payload hash(与 iris_memory 的
 * `_canonical_json_bytes`(ensure_ascii=False, sort_keys=True, separators=(",",":"))+
 * sha256 逐字节一致 —— 跨仓库测试已验证)。 */
export function canonicalPayloadHash(publication: unknown): string {
  return createHash("sha256").update(canonicalJson(publication), "utf8").digest("hex");
}

/**
 * iris_agent#64:解析并验证 Memory acceptance/duplicate-replay receipt 的
 * 版本化不可变绑定身份。任何一项不匹配 → null(fail closed):
 *  - schemaVersion/status 必须是契约常量;
 *  - receipt.publicationId === 被投递的 publicationId;
 *  - receipt.canonicalPayloadHash === 本地重算的 canonical payload hash;
 *  - receipt.contractVersion === 请求的 contractVersion。
 */
export function parseBoundReceipt(
  body: Record<string, unknown>,
  expected: {
    expectedPublicationId: string;
    expectedCanonicalPayloadHash: string;
    expectedContractVersion: string;
  },
): MemoryAcceptanceReceipt | null {
  const schemaVersion = body["schemaVersion"];
  const status = body["status"];
  if (schemaVersion === "duplicate-replay-receipt-v2" && status === "duplicate_replay") {
    // iris_memory#11: v2 duplicate receipts bind via the ORIGINAL
    // publication identity — the replay is only valid when the original
    // publication + payload hash + contract version match what we sent.
    const originalPublicationId = body["originalPublicationId"];
    const originalCanonicalPayloadHash = body["originalCanonicalPayloadHash"];
    const originalContractVersion = body["originalContractVersion"];
    const originalAcceptedAt = body["originalAcceptedAt"];
    const replayedAt = body["replayedAt"];
    if (
      typeof originalPublicationId !== "string" ||
      originalPublicationId !== expected.expectedPublicationId ||
      typeof originalCanonicalPayloadHash !== "string" ||
      originalCanonicalPayloadHash !== expected.expectedCanonicalPayloadHash ||
      typeof originalContractVersion !== "string" ||
      originalContractVersion !== expected.expectedContractVersion ||
      typeof originalAcceptedAt !== "string" ||
      originalAcceptedAt.length === 0 ||
      typeof replayedAt !== "string" ||
      replayedAt.length === 0
    ) {
      return null;
    }
    return {
      schemaVersion: "duplicate-replay-receipt-v2",
      status: "duplicate_replay",
      originalPublicationId,
      originalContractVersion,
      originalCanonicalPayloadHash,
      originalAcceptedAt,
      replayedAt,
    };
  }
  const receiptId = body["receiptId"];
  const publicationId = body["publicationId"];
  const canonicalPayloadHash = body["canonicalPayloadHash"];
  const contractVersion = body["contractVersion"];
  if (typeof receiptId !== "string" || receiptId.length === 0) {
    return null;
  }
  if (publicationId !== expected.expectedPublicationId) {
    return null; // 回执绑定到别的 Publication(swapped/stale)
  }
  if (canonicalPayloadHash !== expected.expectedCanonicalPayloadHash) {
    return null; // 回执 hash 与投递内容不一致(tampered/mismatched)
  }
  if (contractVersion !== expected.expectedContractVersion) {
    return null; // 契约版本不匹配(不消费未知版本的"看起来成功"回执)
  }
  if (schemaVersion === "acceptance-receipt-v1" && status === "accepted") {
    const acceptedAt = body["acceptedAt"];
    if (typeof acceptedAt !== "string" || acceptedAt.length === 0) {
      return null;
    }
    return {
      schemaVersion: "acceptance-receipt-v1",
      status: "accepted",
      receiptId,
      publicationId,
      canonicalPayloadHash,
      contractVersion,
      acceptedAt,
    };
  }
  if (schemaVersion === "acceptance-receipt-v3" && status === "accepted") {
    // iris_memory#11: v3 receipts carry the per-episode-source hashes; the
    // binding identity (publicationId / canonical payload hash / contract
    // version) is verified above exactly like v1.
    const acceptedAt = body["acceptedAt"];
    const episodeSourceHashes = body["episodeSourceHashes"];
    if (typeof acceptedAt !== "string" || acceptedAt.length === 0) {
      return null;
    }
    if (
      !Array.isArray(episodeSourceHashes) ||
      episodeSourceHashes.length === 0 ||
      !episodeSourceHashes.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))
    ) {
      return null;
    }
    return {
      schemaVersion: "acceptance-receipt-v3",
      status: "accepted",
      receiptId,
      publicationId,
      canonicalPayloadHash,
      contractVersion,
      acceptedAt,
      episodeSourceHashes: episodeSourceHashes as string[],
    };
  }
  if (schemaVersion === "duplicate-replay-receipt-v1" && status === "duplicate_replay") {
    const originalAcceptedAt = body["originalAcceptedAt"];
    if (typeof originalAcceptedAt !== "string" || originalAcceptedAt.length === 0) {
      return null;
    }
    return {
      schemaVersion: "duplicate-replay-receipt-v1",
      status: "duplicate_replay",
      receiptId,
      publicationId,
      canonicalPayloadHash,
      contractVersion,
      originalAcceptedAt,
    };
  }
  return null;
}

/**
 * 基于 fetch 的真实 Memory Client(投递到 iris_memory /historian/publications)。
 * baseUrl 例如 http://127.0.0.1:18080(iris_memory 独立进程)。
 */
export class HttpMemoryClient implements MemoryClientPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async deliverPublication(publication: unknown): Promise<PublicationDeliveryOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    const publicationId = (publication as { publicationId?: string }).publicationId ?? "unknown";
    const contractVersion = "0.3.0";
    try {
      const response = await fetch(`${this.baseUrl}/historian/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "publication-acceptance-request-v3",
          contractVersion,
          idempotencyKey: publicationId,
          publication,
        }),
        signal: controller.signal,
      });
      if (response.status === 200) {
        const body = (await response.json()) as Record<string, unknown>;
        // iris_agent#64: verify the receipt's immutable binding identity —
        // schema/status constants, publicationId, canonical payload hash and
        // contract version must ALL match the exact Publication delivered.
        const receipt = parseBoundReceipt(body, {
          expectedPublicationId: publicationId,
          expectedCanonicalPayloadHash: canonicalPayloadHash(publication),
          expectedContractVersion: contractVersion,
        });
        if (receipt === null) {
          // A 200 that does not bind to this exact Publication is a
          // stale/swapped/tampered receipt — fail closed, never deliver.
          return { ok: false, error: "rejected" };
        }
        return { ok: true, receipt };
      }
      if (response.status === 409) {
        // idempotency/sequence conflict:同 key 但内容不同(或 sequence 乱序)
        // 是错误信号 — Agent 绝不能把冲突当作 delivered(iris_agent#64)。
        return { ok: false, error: "rejected" };
      }
      if (response.status === 400 || response.status === 422) {
        return { ok: false, error: "rejected" };
      }
      // 5xx 或意外状态 → 可重试。
      return { ok: false, error: `http_${response.status}` };
    } catch {
      return { ok: false, error: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 测试用内存 fake:可编程成功/失败。默认(无 queue 时)返回**绑定到被投递
 * publication 的真实回执**(publicationId + canonicalPayloadHash 均来自
 * 请求),模拟真实 iris_memory —— 这样 manager 的 #64 绑定校验路径在
 * 集成测试中真实生效。显式 queue 的 outcome 优先(测试可注入 swapped/
 * tampered 等失败场景)。 */
export class FakeMemoryClient implements MemoryClientPort {
  outcomes: PublicationDeliveryOutcome[] = [];
  delivered: unknown[] = [];
  private next: PublicationDeliveryOutcome | undefined;

  queue(outcome: PublicationDeliveryOutcome): void {
    this.outcomes.push(outcome);
  }

  async deliverPublication(publication: unknown): Promise<PublicationDeliveryOutcome> {
    this.delivered.push(publication);
    const next = this.outcomes.shift();
    if (next !== undefined) {
      return next;
    }
    const publicationId = (publication as { publicationId?: string }).publicationId ?? "unknown";
    return {
      ok: true,
      receipt: {
        schemaVersion: "acceptance-receipt-v1",
        status: "accepted",
        receiptId: `fake-receipt-${publicationId}`,
        publicationId,
        canonicalPayloadHash: canonicalPayloadHash(publication),
        contractVersion: "0.2.0",
        acceptedAt: "2026-08-01T00:00:00.000Z",
      },
    };
  }
}
