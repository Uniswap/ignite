// Startup reconciliation is the healer for the deliberately tolerated
// enqueue crash window. Produced products confirm with no transaction of
// their own, so their reconciliation path must work from declared
// constructor args — the receipt-driven path has nothing to decompose.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeAbiParameters } from 'viem';
import type { RunRecord } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { RunStore } from '../../deployments/RunStore.js';
import { wireVerificationReconciliation } from '../../deployments/verificationIntegration.js';
import type { VerificationQueue } from '../../verifications/VerificationQueue.js';
import { resetFilesystemSingletons } from '../setup.js';

const ADDRESS = '0x0000000000000000000000000000000000000001' as const;
const FACTORY = '0x0000000000000000000000000000000000000301' as const;
const JAR = '0x1111111111111111111111111111111111111111' as const;
const RELEASER = '0x2222222222222222222222222222222222222222' as const;
// The releaser's simulated address went stale and an operator recorded the
// real one; reconciliation must still attribute the producer transaction.
const RELEASER_EXPECTED = '0x3333333333333333333333333333333333333333' as const;
const TX_HASH = `0x${'12'.repeat(32)}` as const;
const HASH = 'a'.repeat(64);
const ITEM = { ok: true, blocking: false, message: 'ok' };
const DEPLOY_FN = {
  type: 'function',
  name: 'deploy',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'owner', type: 'address' }],
  outputs: [
    { name: 'jar', type: 'address' },
    { name: 'releaser', type: 'address' },
  ],
};

function frozenInput(bundle: boolean, abi: unknown[]): RunRecord['inputs'][string] {
  return {
    abi: abi as never,
    creationBytecode: '0x6000',
    compiler: { pluginId: 'foundry', version: '1', settingsHash: HASH },
    artifactHash: HASH,
    repoDirty: false,
    ...(bundle ? { bundleHash: HASH } : {}),
  };
}

function producedRun(): RunRecord {
  return {
    schemaVersion: 1,
    id: '5f0f0000-0000-4000-8000-000000000001',
    profileId: 'p1',
    name: 'TJAR produced run',
    idempotencyKey: 'key-1',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:01:00.000Z',
    status: 'completed',
    plan: {
      schemaVersion: 1,
      chains: [1],
      signers: { global: { pluginId: 'key', accountId: 'one', address: ADDRESS } },
      contracts: [
        { id: 'c1', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a1', contractName: 'Jar', sourcePath: 'Jar.sol' },
        { id: 'c2', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a2', contractName: 'Releaser', sourcePath: 'Releaser.sol' },
        { id: 'factory-abi', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'a3', contractName: 'Factory', sourcePath: 'Factory.sol' },
      ],
      steps: [
        { id: 'factory-call', kind: 'call', target: { kind: 'address', address: FACTORY }, signature: 'deploy(address)', args: { owner: ADDRESS }, abiContractId: 'factory-abi' },
        {
          id: 'jar-product',
          kind: 'deploy',
          contractId: 'c1',
          strategy: { kind: 'plugin', pluginId: 'factory', producedBy: { stepId: 'factory-call', outputIndex: 0 } },
        },
        {
          id: 'releaser-product',
          kind: 'deploy',
          contractId: 'c2',
          strategy: { kind: 'plugin', pluginId: 'factory', producedBy: { stepId: 'factory-call', outputIndex: 1 } },
          args: { jar: { $ref: { kind: 'step', stepId: 'jar-product' } }, threshold: '5' },
        },
      ],
    },
    inputs: {
      c1: frozenInput(true, []),
      c2: frozenInput(true, [
        { type: 'constructor', inputs: [{ name: 'jar', type: 'address' }, { name: 'threshold', type: 'uint256' }] },
      ]),
      'factory-abi': frozenInput(false, [DEPLOY_FN]),
    },
    deploymentTypeBindings: {
      factory: { pluginId: 'factory', pluginVersion: '1.0.0', execution: 'call-products', descriptorHash: HASH },
    },
    rpcSelection: { '1': { endpointId: 'rpc', label: 'Anvil', urlFingerprint: HASH } },
    explorerTargets: { '1': [{ entryId: 'e1', url: 'https://scan.local', verifierPluginId: 'etherscan', label: 'Scan' }] },
    validation: { chains: { '1': { rpc: ITEM, signers: ITEM, args: ITEM, estimation: ITEM, balance: ITEM, inputs: ITEM } } },
    lanes: {
      '1': {
        chainId: 1,
        status: 'completed',
        currentStepIndex: 3,
        steps: [
          {
            stepId: 'factory-call',
            status: 'confirmed',
            attempts: [{ id: 'attempt-1', startedAt: '2026-08-13T00:00:00.000Z', txHash: TX_HASH, nonce: 0 }],
          },
          {
            stepId: 'jar-product',
            status: 'confirmed',
            address: JAR,
            expectedAddress: JAR,
            addressProvenance: { kind: 'observed-at-expected', expectedAddress: JAR, observedAt: '2026-08-13T00:01:00.000Z' },
            attempts: [],
          },
          {
            stepId: 'releaser-product',
            status: 'confirmed',
            address: RELEASER,
            expectedAddress: RELEASER_EXPECTED,
            addressProvenance: {
              kind: 'operator-recorded',
              expectedAddress: RELEASER_EXPECTED,
              recordedAddress: RELEASER,
              recordedAt: '2026-08-13T00:01:00.000Z',
              note: 'factory state advanced before inclusion',
            },
            attempts: [{
              id: 'attempt-2',
              startedAt: '2026-08-13T00:00:30.000Z',
              endedAt: '2026-08-13T00:01:00.000Z',
              resolution: 'record-deployed-address',
              resolutionData: { recordedAddress: RELEASER, note: 'factory state advanced before inclusion' },
            }],
          },
        ],
      },
    },
  } as RunRecord;
}

describe('verification reconciliation for produced products', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-reconcile-'));
    resetFilesystemSingletons();
    FileSystem.getInstance(home);
  });
  afterEach(async () => {
    resetFilesystemSingletons();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('enqueues confirmed produced products from declared constructor args with the producer hash', async () => {
    await new RunStore().create(producedRun());
    const enqueued: Array<{ stepId: string; address: string; creationTxHash: string; encodedConstructorArgs: string }> = [];
    const queue = {
      enqueueForConfirmedStep: async (
        _profileId: string,
        _run: RunRecord,
        _chainId: number,
        stepId: string,
        _contractId: string,
        address: string,
        creationTxHash: string,
        encodedConstructorArgs: string
      ) => {
        enqueued.push({ stepId, address, creationTxHash, encodedConstructorArgs });
      },
      enqueueContractTypeCapture: async () => {},
    } as unknown as VerificationQueue;
    wireVerificationReconciliation(queue);

    await queue.reconcileRuns?.();

    expect(enqueued).toEqual([
      expect.objectContaining({ stepId: 'jar-product', address: JAR, creationTxHash: TX_HASH, encodedConstructorArgs: '0x' }),
      // The operator-recorded product verifies at its RECORDED address, still
      // attributed to the producer call's transaction.
      expect.objectContaining({
        stepId: 'releaser-product',
        address: RELEASER,
        creationTxHash: TX_HASH,
        encodedConstructorArgs: encodeAbiParameters(
          [{ name: 'jar', type: 'address' }, { name: 'threshold', type: 'uint256' }],
          [JAR, 5n]
        ),
      }),
    ]);
  });
});
