import { describe, it, expect } from 'vitest';
import { encodeFunctionResult, parseAbiItem, type AbiFunction } from 'viem';
import type { DeploymentPlan, FrozenInputs, Hex, Hex32 } from '@ignite/api';
import {
  buildChainPredictions,
  buildSchedule,
  predictPlanAddresses,
} from '../../deployments/schedule.js';
import {
  predictFactoryCreate2,
  productInitcodeHash,
} from '../../deployments/factory.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' as Hex;
const SIGNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const PRODUCT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
const SALT = `0x${'11'.repeat(32)}` as Hex32;
const CHAIN = 11155111;

const frozen: FrozenInputs = {
  jar: {
    creationBytecode: '0x6080604052348015600f57600080fd5b50',
    abi: [],
  } as never,
};

function plan(predict: Record<string, unknown>): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [{ id: 'jar' } as never],
    chains: [CHAIN],
    signers: {
      global: {
        pluginId: 'private-key',
        accountId: 'k',
        address: SIGNER,
      } as never,
    },
    steps: [
      {
        id: 'deploy-jar',
        kind: 'deploy',
        contractId: 'jar',
        strategy: {
          kind: 'factory',
          target: { kind: 'address', address: FACTORY },
          signature: 'deploy(address,bytes32)',
          args: { arg0: SIGNER, arg1: SALT },
          predict,
        },
      } as never,
    ],
  };
}

describe('factory deployments in the schedule', () => {
  // The factory is the deployer, so the product address derives from it rather
  // than the canonical CREATE2 proxy.
  it('predicts a raw-create2 product offline from the factory', () => {
    const predictions = predictPlanAddresses(
      plan({ kind: 'create2', salt: SALT }),
      frozen,
      CHAIN
    );
    const expected = predictFactoryCreate2(
      FACTORY,
      SALT,
      productInitcodeHash(frozen.jar!)
    );
    expect(predictions['deploy-jar']?.predictedAddress).toBe(expected);
  });

  it('schedules the factory call as the deploying transaction', () => {
    const target = plan({ kind: 'create2', salt: SALT });
    const predictions = predictPlanAddresses(target, frozen, CHAIN);
    const [entry] = buildSchedule(target, frozen, CHAIN, {
      signers: new Map([['deploy-jar', SIGNER]]),
      predictions,
    });
    expect(entry.kind).toBe('tx');
    // Not a raw create (to: null) and not the CREATE2 proxy — the factory.
    expect(entry.to).toBe(FACTORY);
    expect(entry.data).not.toBe('0x');
    expect(entry.predictedAddress).toBe(
      predictions['deploy-jar']?.predictedAddress
    );
  });

  it('resolves a predict helper through one eth_call', async () => {
    const fn = parseAbiItem(
      'function predictJar(address,bytes32) returns (address)'
    ) as AbiFunction;
    const calls: Array<{ to: Hex; data: Hex }> = [];
    const snapshot = await buildChainPredictions(
      plan({
        kind: 'function',
        signature: 'predictJar(address,bytes32)',
        args: { arg0: SIGNER, arg1: SALT },
      }),
      frozen,
      CHAIN,
      {
        client: {
          getTransactionCount: async () => 0,
          call: async (args) => {
            calls.push(args);
            return {
              data: encodeFunctionResult({
                abi: [fn],
                functionName: fn.name,
                result: PRODUCT as never,
              }),
            };
          },
        },
        signers: new Map([['deploy-jar', SIGNER]]),
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(FACTORY);
    const entry = snapshot.entries['deploy-jar'];
    expect(
      entry && 'predictedAddress' in entry
        ? entry.predictedAddress.toLowerCase()
        : undefined
    ).toBe(PRODUCT.toLowerCase());
  });

  // Without an RPC the address is unknown; reporting it as absent-with-reason
  // keeps review honest instead of inventing an address.
  it('reports the product as absent when no client can run the predict call', async () => {
    const snapshot = await buildChainPredictions(
      plan({
        kind: 'function',
        signature: 'predictJar(address,bytes32)',
        args: { arg0: SIGNER, arg1: SALT },
      }),
      frozen,
      CHAIN,
      { signers: new Map([['deploy-jar', SIGNER]]) }
    );
    const entry = snapshot.entries['deploy-jar'];
    expect(entry && 'absent' in entry ? entry.reason : undefined).toMatch(
      /RPC/i
    );
  });
});
