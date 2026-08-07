/**
 * iris_agent#66 test helper: build a ContextHistoryReadPort stub whose
 * claimUnitsForHistorian serves ContextMessageUnit rows derived from a
 * mutable SessionTreeEntry[] fixture. The Historian's normal semantic input
 * is Context units (never Pi Session transcript), so fixtures that used to
 * feed SessionHistoryReadPort now feed claimUnitsForHistorian through this
 * adapter — keeping the SAME entry data while exercising the #66 boundary.
 */
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import type { ContextMessageUnit } from "../../src/contracts/context-units.js";
import type { ContextHistoryReadPort } from "../../src/context/history-read-port.js";

function roleOf(entry: SessionTreeEntry): "user" | "assistant" | "toolResult" | "system" {
  if (entry.type === "custom_message") {
    return "system";
  }
  const message = (entry as { message?: { role?: string } }).message;
  return (message?.role as "user" | "assistant" | "toolResult" | "system" | undefined) ?? "user";
}

function unitTypeOf(entry: SessionTreeEntry): ContextMessageUnit["unitType"] {
  const role = roleOf(entry);
  if (role === "toolResult") {
    return "tool_result";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "input";
}

/** Convert a fixture SessionTreeEntry[] to ContextMessageUnit rows
 * (entrySeq = 1-based fixture position, mirroring the raw archive mapping). */
export function contextUnitsFromEntries(entries: SessionTreeEntry[]): ContextMessageUnit[] {
  const units: ContextMessageUnit[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    units.push({
      lineageId: "identity-stub",
      runtimeSessionId: (entry as { sessionId?: string }).sessionId ?? "stub-session",
      contextSeq: index + 1,
      unitId: entry.id,
      sourceEventId: entry.id,
      unitType: unitTypeOf(entry),
      disposition: "include",
      entryId: entry.id,
      entrySeq: index + 1,
      contentHash: `stub-${entry.id}`,
      payload: (message as ContextMessageUnit["payload"]) ?? {
        role: "user",
        content: "",
        timestamp: 0,
      },
      paired: false,
      derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
      schemaVersion: "context-unit-v1",
      createdAt: entry.timestamp ?? new Date().toISOString(),
    });
  }
  return units;
}

/** Build a ContextHistoryReadPort stub that serves the fixture units
 * through claimUnitsForHistorian (the #66 normal input path). */
export function createFixtureHistoryPort(options: {
  units?: () => ContextMessageUnit[];
  representedThroughEntrySeq?: number;
}): ContextHistoryReadPort {
  const units = options.units ?? (() => []);
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: options.representedThroughEntrySeq ?? 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    lineageId() {
      return "identity-stub";
    },
    listUnitsForHistorian() {
      return units().map((unit) => ({
        contextUnitId: unit.unitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
        unitType: unit.unitType,
        disposition: unit.disposition,
        contentHash: unit.contentHash,
        derivationRefs: unit.derivationRefs,
      }));
    },
    listUnitsForHistorianByEntrySeq(_r: string, fromEntrySeq: number, toEntrySeq: number) {
      return units()
        .filter(
          (unit) =>
            unit.entrySeq !== undefined &&
            unit.entrySeq >= fromEntrySeq &&
            unit.entrySeq <= toEntrySeq,
        )
        .map((unit) => ({
          contextUnitId: unit.unitId,
          contextSeq: unit.contextSeq,
          runtimeEventId: unit.runtimeEventId ?? unit.sourceEventId,
          unitType: unit.unitType,
          disposition: unit.disposition,
          contentHash: unit.contentHash,
          derivationRefs: unit.derivationRefs,
        }));
    },
    claimUnitsForHistorian(_r: string, fromEntrySeq: number, toEntrySeq: number) {
      return units().filter(
        (unit) =>
          unit.entrySeq !== undefined &&
          unit.entrySeq >= fromEntrySeq &&
          unit.entrySeq <= toEntrySeq,
      );
    },
  };
}
