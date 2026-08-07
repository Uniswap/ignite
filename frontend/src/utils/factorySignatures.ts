// Helpers for reading a factory's deploy functions out of its ABI. A deploy
// function that returns addresses declares its products and names them in its
// outputs; the signature the flow stores must therefore keep the returns
// clause (product discovery) and the parameter names (argument fields keyed by
// real names survive the trip through a plain call step).
import { parseAbiItem, type AbiFunction } from 'viem';

export interface AbiParameter {
  name?: string;
  type: string;
  components?: AbiParameter[];
}

export interface AbiEntry {
  type?: string;
  name?: string;
  inputs?: AbiParameter[];
  outputs?: AbiParameter[];
  stateMutability?: string;
}

/** Functions that could deploy: state-changing and returning an address. */
export function deployCandidates(abi: unknown): AbiEntry[] {
  if (!Array.isArray(abi)) return [];
  return (abi as AbiEntry[]).filter(
    (entry) =>
      entry.type === 'function' &&
      entry.stateMutability !== 'view' &&
      entry.stateMutability !== 'pure' &&
      (entry.outputs ?? []).some((output) => output.type === 'address')
  );
}

// The ABI's shallow `type` for a struct is just "tuple", which no signature
// parser accepts; the components must be expanded into parenthesised form.
function parameterSignature(parameter: AbiParameter): string {
  const type = parameter.type.startsWith('tuple')
    ? `(${(parameter.components ?? []).map(parameterSignature).join(', ')})${parameter.type.slice('tuple'.length)}`
    : parameter.type;
  return parameter.name ? `${type} ${parameter.name}` : type;
}

/**
 * The full human-readable signature of a deploy function, with parameter
 * names and every output (not only addresses: decoding indexes the whole
 * returned tuple, so dropping a non-address output would shift the rest).
 */
export function factoryCallSignature(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map(parameterSignature).join(', ');
  const outputs = (entry.outputs ?? []).map(parameterSignature).join(', ');
  return `${entry.name}(${inputs})${outputs ? ` returns (${outputs})` : ''}`;
}

export function parsedFactoryFunction(
  signature: string | undefined
): AbiFunction | undefined {
  if (!signature?.trim()) return undefined;
  try {
    return parseAbiItem(`function ${signature.trim()}`) as AbiFunction;
  } catch {
    return undefined;
  }
}

/**
 * The contracts a deploy function declares it produces, in order. Unnamed
 * outputs fall back to `output<index>` counted across ALL outputs — the same
 * indexing core uses to decode the call's result, so the names always match.
 */
export function productsOf(signature: string | undefined): string[] {
  const fn = parsedFactoryFunction(signature);
  return (fn?.outputs ?? []).flatMap((output, index) =>
    output.type === 'address' ? [output.name || `output${index}`] : []
  );
}
