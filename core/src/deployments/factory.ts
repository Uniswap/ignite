// Factory deployments: the contract is deployed by CALLING an already-deployed
// factory instead of submitting initcode. The step stays a deploy step, so the
// product keeps pointers, the run artifact and verification; only the
// transaction shape and the address prediction differ.
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  parseAbiItem,
  type AbiFunction,
} from 'viem';
import type {
  ArgValues,
  CallTarget,
  DeployStep,
  DeploymentPlan,
  FrozenInputs,
  Hex,
  Hex32,
} from '@ignite/api';
import { initcodeHashOf } from './create2.js';
import { linkBytecode } from './linking.js';
import { mergeArgs, resolveStepValues, toConstructorArgs } from './resolver.js';
import { ErrorCodes, IgniteError } from '../types/errors.js';

export type FactoryStrategy = Extract<
  NonNullable<DeployStep['strategy']>,
  { kind: 'factory' }
>;

export function isFactoryStrategy(
  strategy: DeployStep['strategy']
): strategy is FactoryStrategy {
  return strategy?.kind === 'factory';
}

/**
 * Deterministic strategies that deploy by submitting INITCODE through the
 * CREATE2 proxy. A factory strategy is deterministic too but deploys by
 * calling a contract, so salt/initcode handling does not apply to it.
 */
export type InitcodeStrategy = Extract<
  NonNullable<DeployStep['strategy']>,
  { kind: 'create2' } | { kind: 'plugin' }
>;

export function isInitcodeStrategy(
  strategy: DeployStep['strategy']
): strategy is InitcodeStrategy {
  return strategy?.kind === 'create2' || strategy?.kind === 'plugin';
}

export function mergeFactoryTarget(
  strategy: FactoryStrategy,
  chainId: number
): CallTarget | undefined {
  return strategy.targetPerChain?.[String(chainId)] ?? strategy.target;
}

export function mergeFactoryArgs(
  strategy: FactoryStrategy,
  chainId: number
): ArgValues {
  return {
    ...(strategy.args ?? {}),
    ...(strategy.argsPerChain?.[String(chainId)] ?? {}),
  };
}

function abiFunction(signature: string, what: string): AbiFunction {
  try {
    return parseAbiItem(`function ${signature}`) as AbiFunction;
  } catch {
    throw new IgniteError(
      `${what} signature ${signature} is invalid`,
      'SIGNATURE_NOT_IN_ABI'
    );
  }
}

/** Calldata for the factory call that performs the deployment. */
export function buildFactoryCalldata(
  step: DeployStep & { strategy: FactoryStrategy },
  chainId: number,
  resolveRef: (stepId: string) => Hex,
  context: {
    frozen?: FrozenInputs;
    contracts?: DeploymentPlan['contracts'];
  } = {}
): Hex {
  const strategy = step.strategy;
  if (!strategy.signature)
    throw new IgniteError(
      `Factory step ${step.id} carries no deploy function`,
      'SIGNATURE_NOT_IN_ABI'
    );
  const fn = abiFunction(strategy.signature, 'Factory');
  // Reuse the shared arg pipeline so pointers, $encode and coercion behave
  // exactly as they do for constructor and call arguments.
  const values = resolveStepValues(
    {
      ...step,
      kind: 'deploy',
      args: mergeFactoryArgs(strategy, chainId),
      argsPerChain: undefined,
    } as DeployStep,
    chainId,
    resolveRef,
    fn.inputs,
    context
  );
  return encodeFunctionData({
    abi: [fn],
    functionName: fn.name,
    args: toConstructorArgs(fn.inputs, values.args, 'call') as never,
  });
}

/** Where the factory call sends its transaction. */
export function resolveFactoryAddress(
  strategy: FactoryStrategy,
  chainId: number,
  resolveRef: (stepId: string) => Hex
): Hex {
  const target = mergeFactoryTarget(strategy, chainId);
  if (!target)
    throw new IgniteError(
      'Factory deployment carries no factory address',
      ErrorCodes.ARG_TYPE_MISMATCH
    );
  return target.kind === 'address' ? target.address : resolveRef(target.stepId);
}

/**
 * Predicting by raw CREATE2 uses the FACTORY as the deployer and the product's
 * creation bytecode as-is: a factory supplies its product's constructor
 * arguments itself, so Ignite cannot reconstruct them. Products with
 * constructor parameters must use the factory's own predict function.
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

/** Args a factory strategy contributes to dependency analysis. */
export function factoryArgRefs(
  strategy: FactoryStrategy,
  chainId: number
): ArgValues {
  return mergeFactoryArgs(strategy, chainId);
}

export { mergeArgs };

/** The address-typed outputs a deploy function declares, in order. */
export function factoryProductOutputs(
  signature: string
): Array<{ name: string; index: number }> {
  const fn = abiFunction(signature, 'Factory');
  return fn.outputs.flatMap((output, index) =>
    output.type === 'address'
      ? [{ name: output.name || `output${index}`, index }]
      : []
  );
}

/**
 * Decodes the addresses a deploy function returns. An eth_call of the very
 * function being sent — same arguments, same sender — yields the addresses it
 * would create, which is how every product of one call is predicted at once.
 */
export function decodeFactoryProducts(
  signature: string,
  result: Hex
): Record<string, Hex> {
  const fn = abiFunction(signature, 'Factory');
  const decoded = decodeFunctionResult({
    abi: [fn],
    functionName: fn.name,
    data: result,
  });
  const values = Array.isArray(decoded) ? decoded : [decoded];
  const products: Record<string, Hex> = {};
  fn.outputs.forEach((output, index) => {
    const value = values[index];
    if (
      output.type !== 'address' ||
      typeof value !== 'string' ||
      !isAddress(value)
    )
      return;
    products[output.name || `output${index}`] = value as Hex;
  });
  return products;
}

/** The product a step takes: its named output, or the first address returned. */
export function productAddress(
  products: Record<string, Hex>,
  output: string | undefined
): Hex | undefined {
  if (output) return products[output];
  return Object.values(products)[0];
}

/** A product whose transaction is another step's factory call. */
export function fulfillingStepId(
  strategy: FactoryStrategy
): string | undefined {
  return strategy.fulfilledBy;
}
