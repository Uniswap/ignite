import { describe, it, expect } from 'vitest';
import {
  keccak256,
  encodeFunctionResult,
  parseAbiItem,
  type AbiFunction,
} from 'viem';
import type { DeployStep, Hex, Hex32 } from '@ignite/api';
import {
  buildFactoryCalldata,
  buildPredictCall,
  isFactoryStrategy,
  mergeFactoryPrediction,
  mergeFactoryTarget,
  predictFactoryCreate2,
  productInitcodeHash,
  resolveFactoryAddress,
} from '../../deployments/factory.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' as Hex;
const OWNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const SALT = `0x${'11'.repeat(32)}` as Hex32;

function factoryStep(overrides: Record<string, unknown> = {}): DeployStep & {
  strategy: Extract<NonNullable<DeployStep['strategy']>, { kind: 'factory' }>;
} {
  return {
    id: 'deploy-jar',
    kind: 'deploy',
    contractId: 'jar',
    strategy: {
      kind: 'factory',
      target: { kind: 'address', address: FACTORY },
      signature: 'deploy(address,bytes32)',
      args: { arg0: OWNER, arg1: SALT },
      predict: {
        kind: 'function',
        signature: 'predictJar(address,bytes32)',
        args: { arg0: OWNER, arg1: SALT },
      },
      ...overrides,
    },
  } as never;
}

const unresolvable = () => {
  throw new Error('no pointers in this test');
};

describe('factory deployment strategy', () => {
  it('recognises the strategy and resolves a literal factory address', () => {
    const step = factoryStep();
    expect(isFactoryStrategy(step.strategy)).toBe(true);
    expect(isFactoryStrategy({ kind: 'create' })).toBe(false);
    expect(resolveFactoryAddress(step.strategy, 1, unresolvable)).toBe(FACTORY);
  });

  it('sends the transaction to a factory named by an earlier step', () => {
    const step = factoryStep({
      target: { kind: 'step', stepId: 'deploy-factory' },
    });
    expect(resolveFactoryAddress(step.strategy, 1, () => FACTORY)).toBe(
      FACTORY
    );
  });

  it('encodes the factory call as its own transaction data', () => {
    const data = buildFactoryCalldata(factoryStep(), 1, unresolvable);
    const selector = keccak256(
      new TextEncoder().encode('deploy(address,bytes32)')
    ).slice(0, 10);
    expect(data.startsWith(selector)).toBe(true);
    // owner and salt are both present in the encoded arguments
    expect(data.toLowerCase()).toContain(OWNER.slice(2).toLowerCase());
    expect(data.toLowerCase()).toContain('11'.repeat(32));
  });

  it('prefers a per-chain factory address and prediction', () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
    const step = factoryStep({
      targetPerChain: { '8453': { kind: 'address', address: other } },
      predictPerChain: { '8453': { kind: 'create2', salt: SALT } },
    });
    expect(resolveFactoryAddress(step.strategy, 8453, unresolvable)).toBe(
      other
    );
    expect(resolveFactoryAddress(step.strategy, 1, unresolvable)).toBe(FACTORY);
    expect(mergeFactoryPrediction(step.strategy, 8453).kind).toBe('create2');
    expect(mergeFactoryPrediction(step.strategy, 1).kind).toBe('function');
    expect(mergeFactoryTarget(step.strategy, 8453).kind).toBe('address');
  });

  // The factory is the deployer for a factory-deployed product, so its address
  // — not the canonical CREATE2 proxy — seeds the prediction.
  it('predicts a create2 product from the factory as deployer', () => {
    const hash = productInitcodeHash({
      creationBytecode: '0x6080604052',
    } as never);
    const fromFactory = predictFactoryCreate2(FACTORY, SALT, hash);
    const fromOther = predictFactoryCreate2(OWNER, SALT, hash);
    expect(fromFactory).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fromFactory).not.toBe(fromOther);
  });

  // Canonical signatures have no `returns` clause, so the eth_call result is a
  // bare left-padded address word.
  it('builds and decodes a predict-helper call', () => {
    const { data, decode } = buildPredictCall(
      {
        kind: 'function',
        signature: 'predictJar(address,bytes32)',
        args: { arg0: OWNER, arg1: SALT },
      },
      1,
      unresolvable
    );
    expect(data.toLowerCase()).toContain(OWNER.slice(2).toLowerCase());
    const word = `0x${'0'.repeat(24)}${OWNER.slice(2)}` as Hex;
    expect(decode(word).toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('decodes a predict helper that declares an address return', () => {
    const { decode } = buildPredictCall(
      {
        kind: 'function',
        signature: 'predictJar(address,bytes32) returns (address)',
        args: { arg0: OWNER, arg1: SALT },
      },
      1,
      unresolvable
    );
    const fn = parseAbiItem(
      'function predictJar(address,bytes32) returns (address)'
    ) as AbiFunction;
    expect(
      decode(
        encodeFunctionResult({
          abi: [fn],
          functionName: fn.name,
          result: OWNER as never,
        })
      ).toLowerCase()
    ).toBe(OWNER.toLowerCase());
  });

  // A helper returning anything other than one address cannot stand in for a
  // deployment address.
  it('rejects a predict helper that does not return a single address', () => {
    expect(() =>
      buildPredictCall(
        {
          kind: 'function',
          signature: 'predictPair(address,bytes32) returns (address,address)',
        } as never,
        1,
        unresolvable
      )
    ).toThrow(/single address/);
    const { decode } = buildPredictCall(
      {
        kind: 'function',
        signature: 'predictJar(address,bytes32)',
        args: { arg0: OWNER, arg1: SALT },
      },
      1,
      unresolvable
    );
    expect(() => decode('0x1234' as Hex)).toThrow(/did not return an address/);
  });

  it('rejects an invalid factory signature', () => {
    expect(() =>
      buildFactoryCalldata(
        factoryStep({ signature: 'not a signature' }),
        1,
        unresolvable
      )
    ).toThrow(/invalid/i);
  });
});
