import { createHash } from "node:crypto";

import type { HistoryProjectionUnit, ProjectedLogicalUnits } from "./projection.js";

/**
 * R2 Feature 6 — Protected tail & tool-arc fences.
 *
 * Authority: OpenCode Magic Context v0.33.0 protected-tail-boundary.ts
 * (commit 48ab531d), algorithmically ported to Iris's raw-entry projection.
 *
 * The protected tail is the newest suffix of the current Runtime Session that
 * MUST be presented to the provider verbatim: from the last safe real-user
 * anchor forward, all logical units (input pairs, tool arcs, reasoning) are
 * protected. The FOLD head is everything before that anchor, bounded by the
 * dynamic token target N.
 *
 * Fences (never cut through):
 *  - a sealed tool arc (assistant toolCall → its ToolResult) is atomic;
 *  - an incomplete tool arc (open, unsealed) is protected — never folded;
 *  - a reasoning unit (thinking part) is atomic — never spliced mid-seam;
 *  - a compaction/branch boundary is atomic.
 *
 * All constants below are locked from the authority's golden fixture set
 * (see evidence/context-golden/provenance.md) so parity is byte-verifiable.
 */

// --- Authority-locked constants (protected-tail-boundary.ts) ---
export const ALPHA = 0.3;
export const FLOOR_RATIO = 0.08;
export const FLOOR_MIN = 2_000;
export const FLOOR_MAX = 12_000;
export const ABS_CAP = 96_000;
export const MAX_USABLE_RATIO = 0.4;
export const RESERVED_HEADROOM_MIN = 1_000;
export const RESERVED_HEADROOM_RATIO = 0.02;
export const NON_EMERGENCY_MAX_CAP = 250_000;
export const FORCE80_MAX_CAP = 500_000;
export const FORCE95_MAX_CAP = 750_000;
export const NORMAL_HYSTERESIS_TOKENS = 256;
export const RECOVERY_NO_HEAD_LIMIT = 2;
export const MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1_000;

// trigger-budget derivation (derive-budgets.ts, authority-locked)
const TRIGGER_BUDGET_PERCENTAGE = 0.05;
const TRIGGER_BUDGET_MIN = 5_000;
const TRIGGER_BUDGET_MAX = 50_000;

export interface ProtectedTailTokenTarget {
  usable: number;
  rawN: number;
  floorN: number;
  ceilingN: number;
  effectiveFloor: number;
  N: number;
  headroom: number;
  triggerBudget: number;
  reserve: number;
}

export interface ProtectedTailPlan {
  /** Raw entry seq (1-based) of the last safe real-user anchor, or null when
   * the projection has no verified input (fail-conservative: fold nothing). */
  lastSafeUserAnchorEntrySeq: number | null;
  /** First raw entry seq included in the protected tail (inclusive). */
  protectedTailStartEntrySeq: number;
  /** Last raw entry seq allowed to be folded (inclusive; < tail start). */
  headEndEntrySeq: number;
  /** Dynamic token target N (authority deriveProtectedTailTokenTarget). */
  tokenTarget: number;
  /** True when the head boundary was pulled back onto a fence (atomic unit). */
  fenced: boolean;
  /** True when an atomic head unit alone exceeds the cap. */
  oversizeAtomicUnit: boolean;
  /** Hysteresis applied: boundary unchanged from the previous plan. */
  hysteresisHeld: boolean;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Authority deriveTriggerBudget (derive-budgets.ts). */
export function deriveTriggerBudget(
  mainContextLimit: number,
  executeThresholdPercentage: number,
): number {
  if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
    return TRIGGER_BUDGET_MIN;
  }
  const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
  const usable = mainContextLimit * thresholdFraction;
  const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
  return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

/** Authority deriveProtectedTailTokenTarget (protected-tail-boundary.ts). */
export function deriveProtectedTailTokenTarget(args: {
  contextLimit: number;
  executeThresholdPercentage: number;
  usagePercentage: number;
  triggerBudget?: number;
}): ProtectedTailTokenTarget {
  const safeContextLimit =
    Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128_000;
  const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
    ? Math.max(0, args.executeThresholdPercentage)
    : 65;
  const usable = Math.max(1, Math.round((safeContextLimit * safeThreshold) / 100));
  const usage = clampPercentage(args.usagePercentage);
  const triggerBudget = args.triggerBudget ?? deriveTriggerBudget(safeContextLimit, safeThreshold);
  const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
  const rawN = Math.round(usable * ALPHA * (1 - usage / 100));
  const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
  const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5));
  const ceilingN = Math.max(
    1,
    Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom),
  );
  const effectiveFloor = Math.min(floorN, ceilingN);
  const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN));
  return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve };
}

/** Authority deriveMinForceEligibleTokens. */
export function deriveMinForceEligibleTokens(scaledN: number): number {
  return Math.min(MIN_FORCE_ELIGIBLE_TOKENS_CAP, Math.max(1, Math.floor(scaledN / 8)));
}

/** Authority nonEmergencyPerRunCap. */
export function nonEmergencyPerRunCap(usable: number, N: number): number {
  return Math.min(
    NON_EMERGENCY_MAX_CAP,
    Math.max(2 * N, Math.min(Math.round(0.25 * usable), 100_000)),
  );
}

/** Authority force80PerRunCap (usage >= 80). */
export function force80PerRunCap(usable: number, N: number): number {
  return Math.min(FORCE80_MAX_CAP, Math.max(3 * N, Math.min(Math.round(0.35 * usable), 150_000)));
}

/** Authority force95PerRunCap (usage >= 95). */
export function force95PerRunCap(usable: number, N: number): number {
  return Math.min(FORCE95_MAX_CAP, Math.max(4 * N, Math.min(Math.round(0.5 * usable), 250_000)));
}

/** Authority selectPerRunCap (pressure-gated tool reclaim). */
export function selectPerRunCap(args: {
  contextLimit: number;
  executeThresholdPercentage: number;
  usagePercentage: number;
  N: number;
}): number {
  const usable = Math.max(
    1,
    Math.round((args.contextLimit * args.executeThresholdPercentage) / 100),
  );
  if (args.usagePercentage >= 95) return force95PerRunCap(usable, args.N);
  if (args.usagePercentage >= 80) return force80PerRunCap(usable, args.N);
  return nonEmergencyPerRunCap(usable, args.N);
}

/**
 * Walk raw-entry token counts from the END of the session and return the
 * first raw entry seq whose suffix (itself..end) reaches `targetTokens`.
 * Mirrors authority findSuffixStartForTokens. Returns entries.length+1 when
 * the whole session is below target (i.e. fold nothing beyond the start).
 */
export function findSuffixStartForTokens(rawTokenCounts: number[], targetTokens: number): number {
  if (targetTokens <= 0) return rawTokenCounts.length + 1;
  let acc = 0;
  for (let index = rawTokenCounts.length - 1; index >= 0; index -= 1) {
    const tokens = rawTokenCounts[index];
    if (tokens === undefined) continue;
    acc += tokens;
    if (acc >= targetTokens) return index + 1;
  }
  return 1;
}

function unitEntrySeq(unit: HistoryProjectionUnit): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.startEntrySeq;
    default:
      return unit.entrySeq;
  }
}

function unitEndEntrySeq(unit: HistoryProjectionUnit): number {
  switch (unit.kind) {
    case "input":
    case "tool_arc":
      return unit.entryRange.endEntrySeq;
    default:
      return unit.entrySeq;
  }
}

/** An OPEN (incomplete) tool arc — an assistant with toolCallIds whose callId
 * never resolves to a ToolResult. Detected by callId set difference (the
 * projection only emits sealed tool_arc units; unresolved calls remain as
 * assistant units carrying toolCallIds). */
export function openToolCallIds(
  units: HistoryProjectionUnit[],
): Array<{ assistantEntrySeq: number; callId: string }> {
  const resolved = new Set<string>();
  for (const unit of units) {
    if (unit.kind === "tool_arc" || unit.kind === "tool_result") {
      resolved.add(unit.toolCallId);
    }
  }
  const open: Array<{ assistantEntrySeq: number; callId: string }> = [];
  for (const unit of units) {
    if (unit.kind !== "assistant") continue;
    for (const callId of unit.toolCallIds) {
      if (!resolved.has(callId)) {
        open.push({ assistantEntrySeq: unit.entrySeq, callId });
      }
    }
  }
  return open;
}

export interface EstimateTokensArgs {
  units: HistoryProjectionUnit[];
  /** Per-unit token estimates aligned by index; falls back to 512/unit. */
  unitTokenCounts?: number[];
}

/**
 * Build the protected-tail plan for the current Runtime Session.
 *
 * @param projection the current-Session logical projection
 * @param tokenTarget the dynamic token target N (deriveProtectedTailTokenTarget)
 * @param opts.unitTokenCounts optional per-unit token estimates
 * @param opts.previousPlan protectedTailStartEntrySeq from the previous pass
 *   for hysteresis (authority NORMAL_HYSTERESIS_TOKENS)
 */
export function resolveProtectedTail(
  projection: ProjectedLogicalUnits,
  tokenTarget: number,
  opts: { unitTokenCounts?: number[]; previousPlan?: ProtectedTailPlan } = {},
): ProtectedTailPlan {
  const { units } = projection;
  const counts = opts.unitTokenCounts ?? units.map(() => 512); // conservative per-unit default
  if (units.length === 0) {
    return {
      lastSafeUserAnchorEntrySeq: null,
      protectedTailStartEntrySeq: 1,
      headEndEntrySeq: 0,
      tokenTarget,
      fenced: false,
      oversizeAtomicUnit: false,
      hysteresisHeld: false,
    };
  }

  // 1. Last safe real-user anchor = newest VERIFIED input unit (issue #6
  //    pairing basis). Unverified/orphan inputs are never anchors.
  let anchorUnitIndex: number | null = null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit?.kind === "input" && unit.verified === true) {
      anchorUnitIndex = index;
    }
  }
  const anchorUnit = anchorUnitIndex === null ? undefined : units[anchorUnitIndex];
  const anchorSeq = anchorUnit === undefined ? null : unitEntrySeq(anchorUnit);

  // 2. Suffix walk from the end (unit-aligned counts): the newest N tokens
  //    form the tail. findSuffixStartForTokens returns a 1-based UNIT
  //    position — clamp to [1, units.length].
  let tailStartUnitIndex = Math.min(
    units.length,
    Math.max(1, findSuffixStartForTokens(counts, tokenTarget)),
  );
  // 3. Routine live-user floor: the tail always covers the last safe real-user
  //    anchor AND everything after it (newest todo/tool state is protected).
  //    The anchor input pair itself is included — never folded by an ordinary
  //    pass. Clamp so the tail spans [anchorUnitIndex..end].
  if (anchorUnitIndex !== null) {
    tailStartUnitIndex = Math.min(tailStartUnitIndex, anchorUnitIndex + 1);
  }

  // 4. Fence: the boundary must land exactly on a UNIT START. Unit spans are
  //    [startEntrySeq, endEntrySeq]; walk backward from the chosen unit so
  //    the boundary never cuts an atomic unit (input pair, tool arc,
  //    reasoning, boundary) in half — pull back to the unit start.
  let fenced = false;
  let boundaryUnitIndex = tailStartUnitIndex;
  while (boundaryUnitIndex > 1) {
    const prev = units[boundaryUnitIndex - 2];
    const cur = units[boundaryUnitIndex - 1];
    if (prev === undefined || cur === undefined) break;
    // If the previous unit's span overlaps the current boundary position
    // (multi-entry units like input pairs / sealed arcs), the boundary must
    // move to the previous unit's START so that unit is wholly in the head.
    if (unitEndEntrySeq(prev) >= unitEntrySeq(cur)) {
      boundaryUnitIndex -= 1;
      fenced = true;
    } else {
      break;
    }
  }

  // 5. An OPEN tool arc at/after the boundary forces the boundary before it:
  //    incomplete invocations are never folded away (authority "incomplete
  //    tool arc fence").
  for (const open of openToolCallIds(units)) {
    const openIndex = units.findIndex(
      (u) => u.kind === "assistant" && u.entrySeq === open.assistantEntrySeq,
    );
    if (openIndex >= 0 && openIndex + 1 >= boundaryUnitIndex) {
      boundaryUnitIndex = openIndex + 1;
      fenced = true;
    }
  }

  // 6. Hysteresis: hold the previous boundary when the move is smaller than
  //    NORMAL_HYSTERESIS_TOKENS (authority NORMAL_HYSTERESIS_TOKENS=256).
  //    Compared in entrySeq space via the boundary unit's start entry seq.
  const boundaryUnit = units[boundaryUnitIndex - 1] ?? units[0];
  const boundaryEntrySeq = boundaryUnit === undefined ? 1 : unitEntrySeq(boundaryUnit);
  let boundary = boundaryEntrySeq;
  let hysteresisHeld = false;
  if (opts.previousPlan !== undefined && opts.previousPlan.protectedTailStartEntrySeq > 0) {
    const prev = opts.previousPlan.protectedTailStartEntrySeq;
    if (Math.abs(boundary - prev) < NORMAL_HYSTERESIS_TOKENS) {
      boundary = prev;
      hysteresisHeld = true;
    }
  }

  const headEnd = boundary - 1;
  // Oversize atomic unit: the first unit of the tail (at the boundary) alone
  // exceeds the fold budget — the fold cannot satisfy the token target
  // without cutting an atomic unit (authority oversizeAtomicUnit).
  let oversizeAtomicUnit = false;
  const firstTailUnit = units[boundaryUnitIndex - 1];
  if (firstTailUnit !== undefined) {
    const tokens = counts[boundaryUnitIndex - 1] ?? 0;
    if (tokens > tokenTarget) {
      oversizeAtomicUnit = true;
    }
  }

  return {
    lastSafeUserAnchorEntrySeq: anchorSeq,
    protectedTailStartEntrySeq: Math.max(1, boundary),
    headEndEntrySeq: Math.max(0, headEnd),
    tokenTarget,
    fenced,
    oversizeAtomicUnit,
    hysteresisHeld,
  };
}

/** sha256 fingerprint of the protected-tail plan identity (deterministic). */
export function protectedTailFingerprint(plan: ProtectedTailPlan): string {
  return createHash("sha256")
    .update(
      [
        plan.lastSafeUserAnchorEntrySeq ?? "null",
        plan.protectedTailStartEntrySeq,
        plan.headEndEntrySeq,
        plan.tokenTarget,
        plan.fenced ? "1" : "0",
      ].join("\0"),
    )
    .digest("hex");
}
