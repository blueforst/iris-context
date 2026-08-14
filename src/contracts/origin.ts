import { createHash } from "node:crypto";

export const ORIGIN_SCHEMA_VERSION = 1;

export type PrincipalKind = "user" | "external_actor" | "environment" | "tool" | "model" | "system";

export type Authority = "user_request" | "notice_only" | "data_only" | "internal_control";

export type Trust = "trusted" | "limited" | "untrusted";

export interface OriginEnvelope {
  schemaVersion: number;
  channel: string;
  principalKind: PrincipalKind;
  principalRef?: string;
  authority: Authority;
  trust: Trust;
  provenanceRef?: string;
}

export interface ExternalizedPayloadRef {
  schemaVersion: number;
  kind: string;
  hash: string;
  byteLength: number;
  uri: string;
}

export type ProvenancedContent =
  | { mode: "inline_text"; text: string }
  | { mode: "image_ref"; ref: ExternalizedPayloadRef }
  | { mode: "external_ref"; ref: ExternalizedPayloadRef };

export interface ProvenancedContentBlock {
  blockId: string;
  sourceOrigin: OriginEnvelope;
  content: ProvenancedContent;
  contentHash: string;
}

export interface InteractionContext {
  interactionId: string;
  localHostMutationRequest?: LocalHostMutationRequest;
}

export interface LocalHostMutationRequest {
  directActionId: string;
  requestedScopes: Array<
    "workspace_write" | "iris_data_root" | "iris_runtime_control" | "arbitrary_host_write"
  >;
  requestHash: string;
}

export interface AgentInput {
  inputId: string;
  triggerOrigin: OriginEnvelope;
  blocks: ProvenancedContentBlock[];
  interaction?: InteractionContext;
}

export function originHash(origin: OriginEnvelope): string {
  const canonical: Record<string, unknown> = {
    schemaVersion: origin.schemaVersion,
    channel: origin.channel,
    principalKind: origin.principalKind,
    principalRef: origin.principalRef ?? null,
    authority: origin.authority,
    trust: origin.trust,
    provenanceRef: origin.provenanceRef ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function directUserRequest(): OriginEnvelope {
  return {
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    channel: "cli",
    principalKind: "user",
    authority: "user_request",
    trust: "limited",
  };
}

export function toolResultOrigin(): OriginEnvelope {
  return {
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    channel: "tool",
    principalKind: "tool",
    authority: "data_only",
    trust: "limited",
  };
}
