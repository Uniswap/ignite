import { describe, it, expect } from 'vitest';
import {
  encodeAbiParameters,
  encodeFunctionResult,
  type AbiFunction,
} from 'viem';
import type { DeploymentPlan, DeployStep, Hex, Step } from '@ignite/api';
import {
  decodeProducedAddresses,
  encodeDeclaredProductArgs,
  isInitcodeStrategy,
  isProducedProductStep,
  isProducedStrategy,
  matchAbiFunctions,
  producedRole,
  productInitcodeHash,
  productsOfProducer,
} from '../../deployments/produced.js';
import { initcodeHashOf } from '../../deployments/create2.js';
import { linkBytecode } from '../../deployments/linking.js';

const JAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
const RELEASER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Hex;
const OWNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const SALT = `0x${'11'.repeat(32)}`;

const producedBy = (outputIndex = 0) => ({ stepId: 'call-factory', outputIndex });
function productStep(id: string, outputIndex: number, extra: Record<string, unknown> = {}): DeployStep {
  return {
    id,
    kind: 'deploy',
    contractId: id,
    strategy: { kind: 'plugin', pluginId: 'factory', producedBy: producedBy(outputIndex) },
    ...extra,
  } as DeployStep;
}
function plan(steps: Step[]): DeploymentPlan {
  return { schemaVersion: 1, contracts: [], chains: [1], signers: {}, steps };
}
const CALL: Step = {
  id: 'call-factory',
  kind: 'call',
  target: { kind: 'address', address: '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' },
  signature: 'deploy(address)',
  args: { owner: OWNER },
  abiContractId: 'factory-abi',
};

const abiFn = (fn: Partial<AbiFunction> & { name: string }): AbiFunction => ({
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [],
  outputs: [],
  ...fn,
} as AbiFunction);

describe('produced-mode classification', () => {
  it('splits plugin strategies into produced and initcode modes on producedBy alone', () => {
    const produced = { kind: 'plugin' as const, pluginId: 'factory', producedBy: producedBy() };
    const create2Mode = { kind: 'plugin' as const, pluginId: 'hook' };
    expect(isProducedStrategy(produced)).toBe(true);
    expect(isInitcodeStrategy(produced)).toBe(false);
    expect(isProducedStrategy(create2Mode)).toBe(false);
    expect(isInitcodeStrategy(create2Mode)).toBe(true);
    expect(isInitcodeStrategy({ kind: 'create2', salt: SALT as never })).toBe(true);
    // Plain creates and absent strategies belong to neither mode.
    expect(isProducedStrategy({ kind: 'create' })).toBe(false);
    expect(isInitcodeStrategy({ kind: 'create' })).toBe(false);
    expect(isProducedStrategy(undefined)).toBe(false);
    expect(isInitcodeStrategy(undefined)).toBe(false);
  });

  it('recognises produced product steps and never call steps', () => {
    expect(isProducedProductStep(productStep('jar', 0))).toBe(true);
    expect(isProducedProductStep(CALL)).toBe(false);
    expect(isProducedProductStep({ id: 'x', kind: 'deploy', contractId: 'x' } as Step)).toBe(false);
  });

  it('collects the products of one producer in plan order', () => {
    const target = plan([CALL, productStep('jar', 0), { id: 'other', kind: 'deploy', contractId: 'other' } as Step, productStep('releaser', 1)]);
    expect(productsOfProducer(target, 'call-factory').map((step) => step.id)).toEqual(['jar', 'releaser']);
    expect(productsOfProducer(target, 'other')).toEqual([]);
  });

  it('derives the produced role a paused step plays', () => {
    const target = plan([CALL, productStep('jar', 0), { id: 'plain', kind: 'deploy', contractId: 'plain' } as Step, { ...CALL, id: 'lonely-call', abiContractId: undefined } as Step]);
    expect(producedRole(target, 'call-factory')).toBe('producer');
    expect(producedRole(target, 'jar')).toBe('product');
    expect(producedRole(target, 'plain')).toBeUndefined();
    // A call with no products can be skipped like any other call.
    expect(producedRole(target, 'lonely-call')).toBeUndefined();
    expect(producedRole(target, 'missing')).toBeUndefined();
  });
});

describe('matching the canonical input-only signature against a frozen ABI', () => {
  const deployOne = abiFn({ name: 'deploy', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: 'jar', type: 'address' }] });
  const deployTwo = abiFn({ name: 'deploy', inputs: [{ name: 'owner', type: 'address' }, { name: 'salt', type: 'bytes32' }], outputs: [{ name: 'jar', type: 'address' }, { name: 'releaser', type: 'address' }] });
  const tupled = abiFn({ name: 'deploy', inputs: [
    { name: 'salt', type: 'bytes32' },
    { name: 'config', type: 'tuple', components: [{ name: 'owner', type: 'address' }, { name: 'fee', type: 'uint256' }] },
  ], outputs: [{ name: 'jar', type: 'address' }] });

  it('keeps overloads distinct', () => {
    const abi = [deployOne, deployTwo, { type: 'constructor', inputs: [] }, { bogus: true }];
    expect(matchAbiFunctions(abi, 'deploy(address)')).toEqual([deployOne]);
    expect(matchAbiFunctions(abi, 'deploy(address,bytes32)')).toEqual([deployTwo]);
    expect(matchAbiFunctions(abi, 'deploy(uint256)')).toEqual([]);
  });

  it('expands tuple components into the canonical form', () => {
    expect(matchAbiFunctions([tupled], 'deploy(bytes32,(address,uint256))')).toEqual([tupled]);
    expect(matchAbiFunctions([tupled], 'deploy(bytes32,tuple)')).toEqual([]);
  });

  it('returns every duplicate match so callers can reject ambiguity', () => {
    expect(matchAbiFunctions([deployOne, { ...deployOne }], 'deploy(address)')).toHaveLength(2);
  });

  it('tolerates a non-array ABI and malformed entries', () => {
    expect(matchAbiFunctions(undefined, 'deploy(address)')).toEqual([]);
    expect(matchAbiFunctions({ not: 'an abi' }, 'deploy(address)')).toEqual([]);
    expect(matchAbiFunctions([null, 42, { type: 'function' }], 'deploy(address)')).toEqual([]);
  });
});

describe('decoding producer call return data positionally', () => {
  it('keys every address output by its position and skips interleaved non-address outputs', () => {
    const fn = abiFn({ name: 'deploy', outputs: [
      { name: 'jar', type: 'address' },
      { name: 'fee', type: 'uint256' },
      { name: 'releaser', type: 'address' },
    ] });
    const data = encodeFunctionResult({ abi: [fn], functionName: 'deploy', result: [JAR, 5n, RELEASER] as never });
    const decoded = decodeProducedAddresses(fn, data);
    expect([...decoded.keys()]).toEqual([0, 2]);
    expect(decoded.get(0)?.toLowerCase()).toBe(JAR.toLowerCase());
    expect(decoded.get(2)?.toLowerCase()).toBe(RELEASER.toLowerCase());
  });

  it('handles the single-output scalar decode shape', () => {
    const fn = abiFn({ name: 'deployOne', outputs: [{ name: 'product', type: 'address' }] });
    const data = encodeFunctionResult({ abi: [fn], functionName: 'deployOne', result: JAR as never });
    expect(decodeProducedAddresses(fn, data).get(0)?.toLowerCase()).toBe(JAR.toLowerCase());
  });

  it('ignores values that are not addresses', () => {
    const fn = abiFn({ name: 'count', outputs: [{ name: 'total', type: 'uint256' }] });
    const data = encodeFunctionResult({ abi: [fn], functionName: 'count', result: 7n as never });
    expect(decodeProducedAddresses(fn, data).size).toBe(0);
  });
});

describe('review-only product initcode hash', () => {
  it('hashes the creation bytecode as-is when nothing is linked', () => {
    expect(productInitcodeHash({ creationBytecode: '0x6080', abi: [] } as never)).toBe(initcodeHashOf('0x6080'));
  });

  it('links library placeholders before hashing', () => {
    const unlinked = `0x60${'zz'.repeat(20)}00`;
    const refs = { 'src/L.sol': { L: [{ start: 1, length: 20 }] } };
    const libraries = { 'src/L.sol:L': OWNER };
    expect(
      productInitcodeHash({ creationBytecode: unlinked, creationCodeLinkReferences: refs, abi: [] } as never, libraries)
    ).toBe(initcodeHashOf(linkBytecode(unlinked, refs, libraries)));
  });
});

describe('encoding a product\'s declared constructor arguments for verification', () => {
  const ctorAbi = [{ type: 'constructor', inputs: [{ name: 'jar', type: 'address' }, { name: 'threshold', type: 'uint256' }] }];
  const input = (abi: unknown) => ({ abi, creationBytecode: '0x6081' }) as never;
  const unresolvable = (): Hex => {
    throw new Error('no pointers in this test');
  };

  it('needs no declaration for a constructor with no inputs', () => {
    expect(encodeDeclaredProductArgs(productStep('jar', 0), input([]), 1, unresolvable)).toBe('0x');
    expect(encodeDeclaredProductArgs(productStep('jar', 0), input([{ type: 'constructor', inputs: [] }]), 1, unresolvable)).toBe('0x');
  });

  it('returns undefined for a partial declaration instead of guessing', () => {
    const step = productStep('releaser', 1, { args: { jar: JAR } });
    expect(encodeDeclaredProductArgs(step, input(ctorAbi), 1, unresolvable)).toBeUndefined();
  });

  it('encodes a complete declaration against the frozen constructor ABI', () => {
    const step = productStep('releaser', 1, { args: { jar: JAR, threshold: '5' } });
    expect(encodeDeclaredProductArgs(step, input(ctorAbi), 1, unresolvable)).toBe(
      encodeAbiParameters([{ name: 'jar', type: 'address' }, { name: 'threshold', type: 'uint256' }], [JAR, 5n])
    );
  });

  it('resolves pointer declarations through resolveRef', () => {
    const step = productStep('releaser', 1, { args: { jar: { $ref: { kind: 'step', stepId: 'jar-product' } }, threshold: '5' } });
    const encoded = encodeDeclaredProductArgs(step, input(ctorAbi), 1, () => JAR);
    expect(encoded?.toLowerCase()).toContain(JAR.slice(2).toLowerCase());
  });

  it('addresses unnamed constructor inputs by their positional keys', () => {
    const anonymous = [{ type: 'constructor', inputs: [{ name: '', type: 'address' }] }];
    const step = productStep('releaser', 1, { args: { arg0: JAR } });
    expect(encodeDeclaredProductArgs(step, input(anonymous), 1, unresolvable)).toBe(
      encodeAbiParameters([{ name: '', type: 'address' }], [JAR])
    );
  });
});
