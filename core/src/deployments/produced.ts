// Produced deployments: the contract is created by another step's CALL (a
// call-products deployment-type plugin composed the pair at authoring time)
// instead of submitting initcode. The product stays a deploy step, so it keeps
// pointers, the run artifact and verification; only the transaction shape and
// the address lifecycle differ. The composing plugin never executes here —
// validation, prediction, scheduling, retry, and execution work from the
// frozen plan and host semantics alone.
import {
  decodeFunctionResult,
  encodeAbiParameters,
  isAddress,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem';
import type {
  DeploymentPlan,
  DeployStep,
  FrozenInputs,
  Hex,
  Hex32,
  Step,
} from '@ignite/api';
import { initcodeHashOf } from './create2.js';
import { linkBytecode } from './linking.js';
import { mergeArgs, resolveStepValues, toConstructorArgs } from './resolver.js';

export type PluginStrategy = Extract<
  NonNullable<DeployStep['strategy']>,
  { kind: 'plugin' }
>;
export type ProducedStrategy = PluginStrategy & {
  producedBy: NonNullable<PluginStrategy['producedBy']>;
};
export type ProducedProductStep = DeployStep & { strategy: ProducedStrategy };

/**
 * Produced mode: `producedBy` names the call step whose transaction creates
 * this contract. A produced step never builds initcode, never invokes plugin
 * prepare/validate operations, never mines a salt, and never enters
 * collision/acknowledgement recovery; `params` are opaque composition
 * provenance and are not interpreted during execution.
 */
export function isProducedStrategy(
  strategy: DeployStep['strategy']
): strategy is ProducedStrategy {
  return strategy?.kind === 'plugin' && strategy.producedBy !== undefined;
}

export function isProducedProductStep(step: Step): step is ProducedProductStep {
  return step.kind === 'deploy' && isProducedStrategy(step.strategy);
}

/**
 * Deterministic strategies that deploy by submitting INITCODE through the
 * CREATE2 proxy. A plugin strategy is CREATE2 mode exactly when it has no
 * producer; a produced product is deterministic too but its transaction is
 * the producer call, so salt/initcode handling does not apply to it.
 */
export type InitcodeStrategy = Extract<
  NonNullable<DeployStep['strategy']>,
  { kind: 'create2' } | { kind: 'plugin' }
>;

export function isInitcodeStrategy(
  strategy: DeployStep['strategy']
): strategy is InitcodeStrategy {
  return (
    strategy?.kind === 'create2' ||
    (strategy?.kind === 'plugin' && strategy.producedBy === undefined)
  );
}

/** The produced products of one producer call step, in plan order. */
export function productsOfProducer(
  plan: DeploymentPlan,
  producerId: string
): ProducedProductStep[] {
  return plan.steps.filter(
    (step): step is ProducedProductStep =>
      isProducedProductStep(step) && step.strategy.producedBy.stepId === producerId
  );
}

/**
 * The produced role a paused step plays, if any — the shared input to
 * `allowedActions`. A producer with products cannot be skipped without
 * stranding them; an unresolved product cannot be skipped without stranding
 * everything that points at it.
 */
export function producedRole(
  plan: DeploymentPlan,
  stepId: string
): 'producer' | 'product' | undefined {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) return undefined;
  if (step.kind === 'call')
    return productsOfProducer(plan, stepId).length ? 'producer' : undefined;
  return isProducedProductStep(step) ? 'product' : undefined;
}

/**
 * Every ABI function whose canonical input-only signature matches. Call steps
 * store that canonical form; the frozen ABI entry — not the stored string —
 * is the authority for parameter names, outputs, and payability.
 */
export function matchAbiFunctions(abi: unknown, signature: string): AbiFunction[] {
  if (!Array.isArray(abi)) return [];
  return abi.filter((entry): entry is AbiFunction => {
    if (!entry || typeof entry !== 'object' || (entry as { type?: string }).type !== 'function') return false;
    try {
      return toFunctionSignature(entry as AbiFunction) === signature;
    } catch {
      return false;
    }
  });
}

/**
 * Decodes the addresses a producer call returns, keyed by output index.
 * An eth_call of the very transaction being sent — same target, arguments,
 * sender, and value — yields the addresses it would create, which is how
 * every product of one call is predicted at once. Output indexes are
 * positional against the frozen authoritative ABI.
 */
export function decodeProducedAddresses(fn: AbiFunction, data: Hex): Map<number, Hex> {
  const decoded = decodeFunctionResult({ abi: [fn], functionName: fn.name, data });
  const values = fn.outputs.length <= 1 ? [decoded] : (decoded as readonly unknown[]);
  const addresses = new Map<number, Hex>();
  fn.outputs.forEach((output, index) => {
    const value = values[index];
    if (output.type !== 'address' || typeof value !== 'string' || !isAddress(value)) return;
    addresses.set(index, value as Hex);
  });
  return addresses;
}

/**
 * Predicting by raw CREATE2 uses the PRODUCER as the deployer and the
 * product's creation bytecode as-is: the producer supplies its product's
 * constructor arguments itself, so Ignite cannot reconstruct them. This hash
 * is review display data only.
 */
export function productInitcodeHash(
  input: FrozenInputs[string],
  libraries: Record<string, Hex> = {}
): Hex32 {
  const code = input.creationCodeLinkReferences
    ? linkBytecode(
        input.creationBytecode,
        input.creationCodeLinkReferences,
        libraries
      )
    : (input.creationBytecode as Hex);
  return initcodeHashOf(code);
}

/**
 * The encoded constructor arguments a produced product declares for
 * verification. The producer supplies these onchain — Ignite cannot recover
 * them (see productInitcodeHash) — so a step-level declaration covering
 * every constructor input is resolved through the ordinary arg pipeline and
 * encoded for the explorer. Anything less is not an error: it only means
 * the product cannot be auto-verified. A constructor with no inputs needs
 * no declaration at all.
 */
export function encodeDeclaredProductArgs(
  step: DeployStep,
  input: FrozenInputs[string],
  chainId: number,
  resolveRef: (stepId: string) => Hex,
  context: {
    frozen?: FrozenInputs;
    contracts?: DeploymentPlan['contracts'];
  } = {}
): Hex | undefined {
  const inputs = ((input.abi as Abi).find(
    (entry) => entry.type === 'constructor'
  )?.inputs ?? []) as readonly AbiParameter[];
  if (!inputs.length) return '0x';
  const merged = mergeArgs(step, chainId);
  const undeclared = inputs.some(
    (entry, index) =>
      !Object.prototype.hasOwnProperty.call(
        merged,
        entry.name || `arg${index}`
      )
  );
  if (undeclared) return undefined;
  const values = resolveStepValues(step, chainId, resolveRef, inputs, context);
  return encodeAbiParameters(
    inputs,
    toConstructorArgs(inputs, values.args, 'constructor') as readonly unknown[]
  );
}
