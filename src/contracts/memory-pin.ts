import pin from "./pins/memory-contracts.json" with { type: "json" };

export const MEMORY_CONTRACTS_PIN = pin;

export function memoryContractsVersion(): string {
  return `${pin.version}+${pin.publishStatus}`;
}
