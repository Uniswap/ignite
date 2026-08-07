import { describe, it, expect, vi } from 'vitest';
import { encodeFunctionResult, parseAbiItem, type AbiFunction } from 'viem';
import type { DeploymentPlan, FrozenInputs } from '@ignite/api';
import { validatePlan } from '../../deployments/validation.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6';
const SIGNER = '0x0000000000000000000000000000000000000001';
const JAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RELEASER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const HASH = 'b'.repeat(64);
const SIGNATURE =
  'deploy(address owner, bytes32 salt) returns (address jar, address releaser)';

// The releaser deliberately declares constructor inputs: the factory supplies
// them onchain, so validation must not demand them from the operator.
const frozen: FrozenInputs = {
  jar: {
    abi: [],
    creationBytecode: '0x6080',
    compiler: { pluginId: 'foundry', version: '1.0.0', settingsHash: HASH },
    artifactHash: HASH,
    repoDirty: false,
  },
  releaser: {
    abi: [
      {
        type: 'constructor',
        inputs: [
          { name: 'tokenJar', type: 'address' },
          { name: 'recipient', type: 'address' },
        ],
      },
    ],
    creationBytecode: '0x6081',
    compiler: { pluginId: 'foundry', version: '1.0.0', settingsHash: HASH },
    artifactHash: HASH,
    repoDirty: false,
  },
};

function contract(id: string, contractName: string) {
  return {
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `out/${contractName}.json`,
    contractName,
    sourcePath: `src/${contractName}.sol`,
  };
}

/** The canonical flow shape: one call step, every product fulfilled by it. */
function factoryPlan(): DeploymentPlan {
  return {
    schemaVersion: 1,
    chains: [1],
    contracts: [contract('jar', 'TokenJar'), contract('releaser', 'ExchangeReleaser')],
    signers: {
      global: { pluginId: 'key', accountId: 'account', address: SIGNER },
    },
    steps: [
      {
        id: 'call-factory',
        kind: 'call',
        target: { kind: 'address', address: FACTORY },
        signature: SIGNATURE,
        args: { owner: SIGNER, salt: `0x${'11'.repeat(32)}` },
      },
      {
        id: 'product-jar',
        kind: 'deploy',
        contractId: 'jar',
        strategy: { kind: 'factory', fulfilledBy: 'call-factory', output: 'jar' },
      },
      {
        id: 'product-releaser',
        kind: 'deploy',
        contractId: 'releaser',
        strategy: { kind: 'factory', fulfilledBy: 'call-factory', output: 'releaser' },
      },
    ],
  };
}

function deps(): any {
  const fn = parseAbiItem(`function ${SIGNATURE}`) as AbiFunction;
  return {
    freezeInputs: vi.fn(async () => frozen),
    resolveRpcEndpoint: vi.fn(async (_chainId: number, endpointId: string) => ({
      id: endpointId,
      label: 'Anvil',
      url: 'https://rpc.example/secret',
    })),
    verifyRpcEndpoint: vi.fn(async () => ({
      ok: true,
      reportedChainId: 1,
      chainIdMatch: true,
      blockAgeSeconds: 2,
      checkedAt: '2026-08-06T00:00:00.000Z',
    })),
    updateVerification: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => [
      {
        pluginId: 'key',
        name: 'Key',
        state: 'ok',
        accounts: [{ id: 'account', address: SIGNER }],
      },
    ]),
    createClient: vi.fn(() => ({
      estimateGas: vi.fn(async () => 100n),
      getBalance: vi.fn(async () => 10_000n),
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
      })),
      getTransactionCount: vi.fn(async () => 0),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async () => undefined),
      call: vi.fn(async () => ({
        data: encodeFunctionResult({
          abi: [fn],
          functionName: fn.name,
          result: [JAR, RELEASER] as never,
        }),
      })),
    })),
    captureBundles: vi.fn(async () => ({})),
    resolveExplorers: vi.fn(async () => []),
    makeForkRunner: vi.fn(async () => undefined),
    deploymentTypes: { list: vi.fn(async () => []) } as never,
  };
}

describe('validating the canonical factory flow plan', () => {
  it('does not demand constructor arguments from factory products', async () => {
    const result = await validatePlan(factoryPlan(), { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({ ok: true });
  });

  it('surfaces every product prediction even with no create2 steps', async () => {
    const result = await validatePlan(factoryPlan(), { '1': 'rpc-1' }, deps());
    const item = result.report.chains['1'].create2;
    expect(item).toMatchObject({ ok: true });
    const predicted = item?.details?.predicted as Record<
      string,
      { predictedAddress: string }
    >;
    expect(predicted['product-jar'].predictedAddress.toLowerCase()).toBe(
      JAR.toLowerCase()
    );
    expect(predicted['product-releaser'].predictedAddress.toLowerCase()).toBe(
      RELEASER.toLowerCase()
    );
  });

  it('still checks the deploy function arguments of a carry-the-call step', async () => {
    const carry = factoryPlan();
    carry.steps = [
      {
        id: 'product-jar',
        kind: 'deploy',
        contractId: 'jar',
        strategy: {
          kind: 'factory',
          target: { kind: 'address', address: FACTORY },
          signature: SIGNATURE,
          // salt is deliberately missing.
          args: { owner: SIGNER },
          output: 'jar',
        },
      },
    ];
    carry.contracts = [contract('jar', 'TokenJar')];
    const result = await validatePlan(carry, { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'MISSING_ARGUMENT',
    });
  });
});
