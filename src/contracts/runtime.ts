export type RuntimeEpochStatus = "creating" | "active" | "closing" | "closed" | "closed_incomplete";

export interface RuntimeSessionEpoch {
  epochId: string;
  runtimeSessionId: string;
  localDate: string;
  ordinalWithinDate: number;
  status: RuntimeEpochStatus;
  previousEpochId?: string;
  continuitySnapshotId?: string;
  runtimeRecoveryNoticeId?: string;
  createdAt: string;
  closedAt?: string;
}

export interface HistoryEntryRef {
  runtimeSessionId: string;
  entryId: string;
  entrySeq: number;
  contentHash: string;
}

export interface HistoryRangeRef {
  runtimeSessionId: string;
  startEntrySeq: number;
  endEntrySeq: number;
  rangeHash: string;
}

export interface RuntimeRecoveryNotice {
  noticeId: string;
  sourceRuntimeSessionId: string;
  sourceEpochSequence: number;
  toolExecutionKey: string;
  toolName: string;
  outcome: "succeeded" | "failed" | "outcome_unknown";
  nextAction: "continue" | "reconcile" | "ask_user";
  createdAt: string;
  contentHash: string;
}

export interface RuntimeSessionEpochPort {
  getActive(): Promise<RuntimeSessionEpoch | null>;
  ensureActive(now: string): Promise<RuntimeSessionEpoch>;
  requestRollover(reason: string): Promise<void>;
  rolloverAfterSettled(): Promise<RuntimeSessionEpoch>;
}
