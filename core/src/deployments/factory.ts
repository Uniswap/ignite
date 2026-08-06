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
  FactoryPrediction,
  FrozenInputs,
  Hex,
  Hex32,
} from '@ignite/api';
import { initcodeHashOf, predictCreate2Address } from './create2.js';
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

/** The salt a factory product is predicted with, when raw CREATE2 is used. */
export function factoryPredictSalt(
  strategy: FactoryStrategy,
  chainId: number
): Hex32 | undefined {
  const prediction = mergeFactoryPrediction(strategy, chainId);
  return prediction.kind === 'create2' ? prediction.salt : undefined;
}

export function mergeFactoryTarget(
  strategy: FactoryStrategy,
  chainId: number
): CallTarget {
  return strategy.targetPerChain?.[String(chainId)] ?? strategy.target;
}

export function mergeFactoryPrediction(
  strategy: FactoryStrategy,
  chainId: number
): FactoryPrediction {
  return strategy.predictPerChain?.[String(chainId)] ?? strategy.predict;
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

export function predictFactoryCreate2(
  factory: Hex,
  salt: Hex32,
  initcodeHash: Hex32
): Hex {
  return predictCreate2Address(salt, initcodeHash, factory);
}

/** Calldata for the factory's predict helper, and the decoder for its result. */
export function buildPredictCall(
  prediction: Extract<FactoryPrediction, { kind: 'function' }>,
  chainId: number,
  resolveRef: (stepId: string) => Hex,
  context: {
    frozen?: FrozenInputs;
    contracts?: DeploymentPlan['contracts'];
  } = {}
): { data: Hex; decode: (result: Hex) => Hex } {
  const fn = abiFunction(prediction.signature, 'Predict');
  // Canonical signatures carry no `returns` clause (the plan schema's
  // signature pattern forbids one), so the ABI item has no declared outputs
  // and the result is decoded as a bare address word instead.
  if (
    fn.outputs.length > 1 ||
    (fn.outputs.length === 1 && fn.outputs[0]?.type !== 'address')
  )
    throw new IgniteError(
      `Predict function ${prediction.signature} must return a single address`,
      ErrorCodes.ARG_TYPE_MISMATCH
    );
  const values = resolveStepValues(
    {
      kind: 'deploy',
      id: 'predict',
      contractId: '',
      args: prediction.args ?? {},
    } as unknown as DeployStep,
    chainId,
    resolveRef,
    fn.inputs,
    context
  );
  return {
    data: encodeFunctionData({
      abi: [fn],
      functionName: fn.name,
      args: toConstructorArgs(fn.inputs, values.args, 'call') as never,
    }),
    decode: (result: Hex) => {
      const address =
        fn.outputs.length === 1
          ? (() => {
              const decoded = decodeFunctionResult({
                abi: [fn],
                functionName: fn.name,
                data: result,
              });
              return Array.isArray(decoded) ? decoded[0] : decoded;
            })()
          : // A single address occupies one left-padded 32-byte word.
            /^0x[0-9a-fA-F]{64}$/.test(result)
            ? (`0x${result.slice(-40)}` as Hex)
            : undefined;
      if (typeof address !== 'string' || !isAddress(address))
        throw new IgniteError(
          `Predict function ${prediction.signature} did not return an address`,
          ErrorCodes.ARG_TYPE_MISMATCH
        );
      return address as Hex;
    },
  };
}

/** Args a factory strategy contributes to dependency analysis. */
export function factoryArgRefs(
  strategy: FactoryStrategy,
  chainId: number
): ArgValues {
  return mergeFactoryArgs(strategy, chainId);
}

export function mergedPredictArgs(prediction: FactoryPrediction): ArgValues {
  return prediction.kind === 'function' ? (prediction.args ?? {}) : {};
}

export { mergeArgs };
