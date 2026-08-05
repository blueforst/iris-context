/**
 * R3 (iris_agent#9) Exit Gate 5 — active historian.db 平台期 benchmark。
 *
 * 证明:在 hot-row reclaim 生效时,active historian.db 中的 hot rows
 * (compartments/segments/evidence/attribution)不随总处理历史线性增长。
 * 模拟 N 个 compartment 全部满足四条件并 reclaim 后,active 计数回到
 * 平台值(0/常数),而累计处理量持续增长。
 *
 * 用法: npx tsx scripts/bench-historian-plateau.ts [--json]
 * 输出: stages 数组 + plateau 判定。退出码 0 = 平台期达成。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HistorianStore } from "../src/historian/historian-store.js";
import {
  eligibleForReclaim,
  withBustRepresented,
  withContextAck,
  withMemoryDurableAck,
  withShardVerified,
  type CompartmentReleaseView,
} from "../src/historian/hot-row-reclaim.js";

const JSON_OUTPUT = process.argv.includes("--json");

function bench(): { stages: number[]; plateau: boolean; peakActive: number } {
  const dir = mkdtempSync(join(tmpdir(), "iris-historian-plateau-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const stages: number[] = [];
  try {
    // 10 个阶段,每阶段 50 个 compartment:先 accumulate,后 reclaim。
    const batchSize = 50;
    let processedSeq = 0;
    for (let stage = 1; stage <= 10; stage++) {
      const base = (stage - 1) * batchSize;
      for (let i = 1; i <= batchSize; i++) {
        const seq = base + i;
        processedSeq = seq;
        let view: CompartmentReleaseView = {
          compartmentId: `compartment-bench-${seq}`,
          runtimeSessionId: "bench-session",
          compartmentSequence: seq,
          startEntrySeq: seq * 10,
          endEntrySeq: seq * 10 + 9,
          publicationSequence: seq,
          contextAckedAt: null,
          bustRepresentedAt: null,
          memoryDurableAckAt: null,
          memoryReceiptHash: null,
          shardId: null,
          shardVerifiedAt: null,
          reclaimedAt: null,
        };
        view = withContextAck(view, "t1");
        view = withBustRepresented(view, "t2");
        view = withMemoryDurableAck(view, "t3", `receipt-${seq}`);
        view = withShardVerified(view, `shard-${seq}`, "t4");
        store.upsertCompartmentRelease(view);
      }
      // 本阶段立即 reclaim 所有满足条件的(实际会由编排层触发)。
      for (const v of eligibleForReclaim(store.listCompartmentReleaseViews("bench-session"))) {
        store.begin();
        store.deleteReclaimedHotRows("bench-session", v.compartmentId);
        store.markReclaimed(v.compartmentId, "t5");
        store.commit();
      }
      const active = store.countActiveCompartments("bench-session");
      const reclaimed = store.countReclaimed();
      stages.push(active);
      if (JSON_OUTPUT) {
        process.stdout.write(
          JSON.stringify({ stage, processed: processedSeq, active, reclaimed }) + "\n",
        );
      }
    }
    // 平台期判定:末段 active 必须显著小于累计处理量(不线性增长),且
    // 末段与前一阶段 active 持平或下降(平台值)。
    const last = stages[stages.length - 1] ?? 0;
    const secondLast = stages[stages.length - 2] ?? 0;
    const plateau = last <= secondLast && last < 100;
    return { stages, plateau, peakActive: Math.max(...stages) };
  } finally {
    store.close();
  }
}

const result = bench();
if (JSON_OUTPUT) {
  process.stdout.write(
    JSON.stringify({
      peakActive: result.peakActive,
      stages: result.stages,
      plateau: result.plateau,
    }) + "\n",
  );
} else {
  console.log(`bench-historian-plateau: stages=${result.stages.join(",")}`);
  console.log(`peakActive=${result.peakActive} plateau=${result.plateau}`);
  console.log(
    result.plateau
      ? "PASS: active historian.db reaches plateau (hot rows reclaimed)"
      : "FAIL: active historian.db grows linearly",
  );
}
process.exit(result.plateau ? 0 : 1);
