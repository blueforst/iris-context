import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const IRIS_INPUT_META_CUSTOM_TYPE = "iris_input_meta";
export const IRIS_INPUT_META_CONTENT = "<iris-input-meta/>";
export const M0_EMPTY_BODY = "<session-history></session-history>";
export const M1_EMPTY_PLACEHOLDER =
  "<session-history-since>(no new content since last materialization)</session-history-since>";

export interface ContextSourceSnapshot {
  contextSourceSnapshotId: string;
  runtimeSessionId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  continuitySeedId?: string;
  runtimeRecoveryNoticeId?: string;
  stableMemoryPoolVersion?: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
}

export interface PreparedContextSources {
  contextSourceSnapshotId: string;
  runtimeSessionId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  materializationIdentity: string;
  preparedAt: string;
}

export interface TransformMessagesInput {
  invocationId: string;
  runtimeSessionId: string;
  messages: AgentMessage[];
  model: { provider: string; modelId: string };
  providerProfileId: string;
}

export interface ContextTransformResult {
  messages: AgentMessage[];
  representedBoundaryState: {
    runtimeSessionId: string;
    materializationIdentity: string;
    providerProfileId: string;
  };
}

export interface IrisContextCarrierDetails {
  irisContext: {
    schemaVersion: number;
    runtimeSessionId: string;
    surface: "m0" | "m1";
    materializationId: string;
    contentHash: string;
  };
}
