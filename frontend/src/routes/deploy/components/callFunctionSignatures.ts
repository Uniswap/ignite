import { parseAbiItem, toFunctionSignature, type AbiFunction } from 'viem';
import type { AbiInput } from './AbiArgField';

export interface CallFunctionOption {
  signature: string;
  payable: boolean;
}

type AbiFunctionLike = {
  type?: string;
  name?: string;
  inputs?: AbiInput[];
  stateMutability?: string;
};

function matchingFunction(
  abi: AbiFunctionLike[] | undefined,
  signature: string | undefined
): AbiFunctionLike | undefined {
  if (!signature) return undefined;
  return (abi ?? []).find((item) => {
    if (item.type !== 'function') return false;
    try {
      return toFunctionSignature(item as unknown as AbiFunction) === signature;
    } catch {
      return false;
    }
  });
}

export function callArgumentInputs(
  targetKind: 'step' | 'address' | undefined,
  signature: string | undefined,
  targetAbi: AbiFunctionLike[] | undefined
): AbiInput[] {
  if (!signature) return [];
  if (targetKind === 'step') {
    return matchingFunction(targetAbi, signature)?.inputs ?? [];
  }
  try {
    return (
      (parseAbiItem(`function ${signature}`) as { inputs?: AbiInput[] })
        .inputs ?? []
    );
  } catch {
    return [];
  }
}

function normalizeRecord(
  record: Record<string, unknown> | undefined,
  inputs: AbiInput[]
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  let next: Record<string, unknown> | undefined;
  inputs.forEach((input, index) => {
    const positionalKey = `arg${index}`;
    const namedKey = input.name || positionalKey;
    if (
      namedKey === positionalKey ||
      !Object.prototype.hasOwnProperty.call(record, positionalKey)
    )
      return;
    next ??= { ...record };
    if (!Object.prototype.hasOwnProperty.call(record, namedKey)) {
      next[namedKey] = record[positionalKey];
    }
    delete next[positionalKey];
  });
  return next;
}

export function normalizeCallArgumentKeys(
  args: Record<string, unknown> | undefined,
  argsPerChain: Record<string, Partial<Record<string, unknown>>> | undefined,
  inputs: AbiInput[]
):
  | {
      args?: Record<string, unknown>;
      argsPerChain?: Record<string, Partial<Record<string, unknown>>>;
    }
  | undefined {
  const normalizedArgs = normalizeRecord(args, inputs);
  let normalizedPerChain:
    | Record<string, Partial<Record<string, unknown>>>
    | undefined;
  for (const [chainId, record] of Object.entries(argsPerChain ?? {})) {
    const normalized = normalizeRecord(record, inputs);
    if (!normalized) continue;
    normalizedPerChain ??= { ...argsPerChain };
    normalizedPerChain[chainId] = normalized;
  }
  if (!normalizedArgs && !normalizedPerChain) return undefined;
  return {
    args: normalizedArgs ?? args,
    argsPerChain: normalizedPerChain ?? argsPerChain,
  };
}

/** Build selectors from the ABI rather than reconstructing them from the
 * shallow `type` field. viem expands tuple components into the canonical ABI
 * signature, which keeps overloaded functions distinguishable. */
export function callFunctionOptions(
  abi: AbiFunctionLike[] | undefined
): CallFunctionOption[] {
  return (abi ?? [])
    .filter(
      (item) => item.type === 'function' && item.stateMutability !== 'pure'
    )
    .map((item) => ({
      signature: toFunctionSignature(item as unknown as AbiFunction),
      payable: item.stateMutability === 'payable',
    }));
}
