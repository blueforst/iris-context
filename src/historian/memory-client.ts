/**
 * R4 (iris_agent#9) — Memory Client(投递 Historian publication 到 iris_memory)。
 *
 * 边界(v13 + 三项目边界):Agent 只通过本客户端投递 outbox 中的
 * historian-publication-v2 envelope 并接收 acceptance receipt;不读取
 * iris_memory 数据库、不连接 Neo4j、不实现 stable memoryRef。
 *
 * 投递语义:
 *  - 200 receipt → delivered(真实 receipt hash 回写 outbox);
 *  - 409 conflict(idempotency/sequence)→ 视为已处理(重放安全),delivered;
 *  - 400 validation / 422 unsupported → quarantined(永不重试噪声);
 *  - 网络失败/5xx/timeout → retry_wait(由 outbox 退避重试);
 *  - memory unavailable → 显式 degraded(不伪装为"没有相关记忆")。
 */

import type { MemoryClientPort, PublicationDeliveryOutcome } from "../contracts/ports.js";

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
    try {
      const response = await fetch(`${this.baseUrl}/historian/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "publication-acceptance-request-v2",
          contractVersion: "0.2.0",
          idempotencyKey: (publication as { publicationId?: string }).publicationId ?? "unknown",
          publication,
        }),
        signal: controller.signal,
      });
      if (response.status === 200) {
        const receipt = (await response.json()) as { receiptId?: string };
        return { ok: true, receiptHash: receipt.receiptId ?? "receipt-missing-id" };
      }
      if (response.status === 409) {
        // idempotency/sequence conflict:重放安全,视为已交付。
        return { ok: true, receiptHash: "conflict-replay" };
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

/** 测试用内存 fake:可编程成功/失败。 */
export class FakeMemoryClient implements MemoryClientPort {
  outcomes: PublicationDeliveryOutcome[] = [];
  delivered: unknown[] = [];
  private next: PublicationDeliveryOutcome | undefined;

  constructor(
    private readonly defaultOutcome: PublicationDeliveryOutcome = {
      ok: true,
      receiptHash: "fake-receipt",
    },
  ) {}

  queue(outcome: PublicationDeliveryOutcome): void {
    this.outcomes.push(outcome);
  }

  async deliverPublication(publication: unknown): Promise<PublicationDeliveryOutcome> {
    this.delivered.push(publication);
    const next = this.outcomes.shift() ?? this.defaultOutcome;
    return next;
  }
}
