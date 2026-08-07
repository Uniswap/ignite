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
  decodeFactoryProducts,
  factoryProductOutputs,
  isFactoryStrategy,
  mergeFactoryTarget,
  productAddress,
  resolveFactoryAddress,
} from '../../deployments/factory.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' as Hex;
const OWNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const SALT = `0x${'11'.repeat(32)}` as Hex32;
const PRODUCT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Hex;

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

  it('prefers a per-chain factory address', () => {
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
    const step = factoryStep({
      targetPerChain: { '8453': { kind: 'address', address: other } },
    });
    expect(resolveFactoryAddress(step.strategy, 8453, unresolvable)).toBe(
      other
    );
    expect(resolveFactoryAddress(step.strategy, 1, unresolvable)).toBe(FACTORY);
    expect(mergeFactoryTarget(step.strategy, 8453)?.kind).toBe('address');
  });

  // A deploy function that returns addresses declares its products, and names
  // them: that is how one call is known to produce more than one contract.
  it('reads the products a deploy function declares from its ABI', () => {
    expect(
      factoryProductOutputs(
        'deploy(address,bytes32) returns (address jar, address releaser)'
      )
    ).toEqual([
      { name: 'jar', index: 0 },
      { name: 'releaser', index: 1 },
    ]);
    // Non-address returns are not products.
    expect(
      factoryProductOutputs(
        'deploy(bytes32) returns (address jar, uint256 fee)'
      )
    ).toEqual([{ name: 'jar', index: 0 }]);
  });

  it('decodes every product of one call and picks each step its own', () => {
    const signature =
      'deploy(address,bytes32) returns (address jar, address releaser)';
    const fn = parseAbiItem(`function ${signature}`) as AbiFunction;
    const result = encodeFunctionResult({
      abi: [fn],
      functionName: fn.name,
      result: [OWNER, PRODUCT] as never,
    });
    // viem returns checksummed addresses, so compare case-insensitively.
    const products = decodeFactoryProducts(signature, result);
    expect(Object.keys(products)).toEqual(['jar', 'releaser']);
    expect(productAddress(products, 'releaser')?.toLowerCase()).toBe(
      PRODUCT.toLowerCase()
    );
    // No named output falls back to the first address returned.
    expect(productAddress(products, undefined)?.toLowerCase()).toBe(
      OWNER.toLowerCase()
    );
    expect(productAddress(products, 'missing')).toBeUndefined();
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
