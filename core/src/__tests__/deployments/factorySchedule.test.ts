import { describe, it, expect } from 'vitest';
import { encodeFunctionResult, parseAbiItem, type AbiFunction } from 'viem';
import type { DeploymentPlan, FrozenInputs, Hex } from '@ignite/api';
import {
  buildChainPredictions,
  buildSchedule,
} from '../../deployments/schedule.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' as Hex;
const SIGNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const JAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
const RELEASER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Hex;
const CHAIN = 11155111;
const SIGNATURE =
  'deploy(address,bytes32) returns (address jar, address releaser)';

const frozen: FrozenInputs = {
  jar: { creationBytecode: '0x6080', abi: [] } as never,
  releaser: { creationBytecode: '0x6081', abi: [] } as never,
};

/** A jar step that broadcasts, and a releaser step fulfilled by that call. */
function plan(): DeploymentPlan {
  const strategy = {
    kind: 'factory' as const,
    target: { kind: 'address' as const, address: FACTORY },
    signature: SIGNATURE,
    args: { arg0: SIGNER, arg1: `0x${'11'.repeat(32)}` },
  };
  return {
    schemaVersion: 1,
    contracts: [{ id: 'jar' }, { id: 'releaser' }] as never,
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
        strategy: { ...strategy, output: 'jar' },
      },
      {
        id: 'deploy-releaser',
        kind: 'deploy',
        contractId: 'releaser',
        strategy: { ...strategy, output: 'releaser', fulfilledBy: 'deploy-jar' },
      },
    ] as never,
  };
}

function client(calls: Array<{ to: Hex; data: Hex }>) {
  const fn = parseAbiItem(`function ${SIGNATURE}`) as AbiFunction;
  return {
    getTransactionCount: async () => 0,
    call: async (args: { to: Hex; data: Hex }) => {
      calls.push(args);
      return {
        data: encodeFunctionResult({
          abi: [fn],
          functionName: fn.name,
          result: [JAR, RELEASER] as never,
        }),
      };
    },
  };
}

const signers = new Map([
  ['deploy-jar', SIGNER],
  ['deploy-releaser', SIGNER],
]);

describe('factory deployments producing several contracts', () => {
  // One call creates both contracts, so one simulation predicts both — the
  // releaser needs no predict helper of its own (the factory exposes none).
  it('predicts every product from a single eth_call', async () => {
    const calls: Array<{ to: Hex; data: Hex }> = [];
    const snapshot = await buildChainPredictions(plan(), frozen, CHAIN, {
      client: client(calls),
      signers,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(FACTORY);

    const address = (id: string) => {
      const entry = snapshot.entries[id];
      return entry && 'predictedAddress' in entry
        ? entry.predictedAddress.toLowerCase()
        : undefined;
    };
    expect(address('deploy-jar')).toBe(JAR.toLowerCase());
    expect(address('deploy-releaser')).toBe(RELEASER.toLowerCase());
  });

  // The fulfilled product must not send a second transaction: one call
  // deployed both contracts.
  it('schedules one transaction for the call and none for the fulfilled product', async () => {
    const target = plan();
    const snapshot = await buildChainPredictions(target, frozen, CHAIN, {
      client: client([]),
      signers,
    });
    const schedule = buildSchedule(target, frozen, CHAIN, {
      signers,
      predictions: Object.fromEntries(
        Object.entries(snapshot.entries).flatMap(([id, entry]) =>
          entry && 'predictedAddress' in entry ? [[id, entry]] : []
        )
      ) as never,
    });
    const jar = schedule.find((entry) => entry.stepId === 'deploy-jar');
    const releaser = schedule.find(
      (entry) => entry.stepId === 'deploy-releaser'
    );
    expect(jar?.kind).toBe('tx');
    expect(jar?.to).toBe(FACTORY);
    expect(releaser?.kind).not.toBe('tx');
    expect(releaser?.predictedAddress?.toLowerCase()).toBe(
      RELEASER.toLowerCase()
    );
  });

  it('reports products as absent when no RPC can simulate the call', async () => {
    const snapshot = await buildChainPredictions(plan(), frozen, CHAIN, {
      signers,
    });
    for (const id of ['deploy-jar', 'deploy-releaser']) {
      const entry = snapshot.entries[id];
      expect(entry && 'absent' in entry ? entry.reason : undefined).toMatch(
        /RPC/i
      );
    }
  });
});
