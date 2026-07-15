import { createHash } from "node:crypto";
import { formatUnits, parseUnits } from "viem";

export function usdToAtomic(value: number | string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  const normalized = typeof value === "number" ? decimalNumberToString(value) : value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`Invalid non-negative USD amount: ${normalized}`);
  const fractionalDigits = normalized.split(".")[1]?.length ?? 0;
  if (fractionalDigits > decimals) {
    throw new Error(`USD amount has ${fractionalDigits} decimal places but the token supports ${decimals}`);
  }
  return parseUnits(normalized, decimals);
}

export function atomicToUsd(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals);
}

export function transferMemo(id: string): `0x${string}` {
  return `0x${createHash("sha256").update(id).digest("hex")}`;
}

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

export function safeUsdNumber(amountAtomic: bigint, decimals: number): number {
  const value = Number(atomicToUsd(amountAtomic, decimals));
  if (!Number.isFinite(value)) throw new Error("Amount cannot be represented as a finite USD number");
  return value;
}

function decimalNumberToString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid non-negative USD amount: ${value}`);
  const rendered = value.toString();
  if (!/[eE]/.test(rendered)) return rendered;
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 21 });
}
