import { describe, it, expect, vi } from 'vitest';
import { encodeFunctionResult, type AbiFunction } from 'viem';
import {
  CREATE2_PROXY_ADDRESS,
  CREATE2_PROXY_RUNTIME_CODE,
  type DeploymentPlan,
  type DeploymentTypeInfo,
  type DeployStep,
  type FrozenInputs,
} from '@ignite/api';
import { validatePlan } from '../../deployments/validation.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6';
const SIGNER = '0x0000000000000000000000000000000000000001';
const JAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RELEASER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const HASH = 'b'.repeat(64);
// Call steps store the canonical input-only signature; the frozen
// abiContractId ABI is authoritative for names, outputs, and payability.
const SIGNATURE = 'deploy(address,bytes32)';
const DEPLOY_FN: AbiFunction = {
  type: 'function',
  name: 'deploy',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [
    { name: 'jar', type: 'address' },
    { name: 'releaser', type: 'address' },
  ],
};
const FACTORY_TYPE: DeploymentTypeInfo = {
  pluginId: 'factory',
  pluginVersion: '1.0.0',
  label: 'Factory',
  description: 'Call-products reference plugin',
  execution: 'call-products',
  params: [],
  validateSupported: false,
  composeSupported: true,
};

// The releaser deliberately declares constructor inputs: the producer supplies
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
  'factory-abi': {
    abi: [DEPLOY_FN],
    creationBytecode: '0x6082',
    compiler: { pluginId: 'foundry', version: '1.0.0', settingsHash: HASH },
    artifactHash: HASH,
    repoDirty: false,
  },
  // A CREATE2 deployment whose constructor takes a product's address — the
  // jar-then-releaser shape the spec promises works.
  consumer: {
    abi: [{ type: 'constructor', inputs: [{ name: 'jar', type: 'address' }] }],
    creationBytecode: '0x6083',
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

/** The canonical produced flow: one producer call, every product produced by it. */
function producedPlan(): DeploymentPlan {
  return {
    schemaVersion: 1,
    chains: [1],
    contracts: [
      contract('jar', 'TokenJar'),
      contract('releaser', 'ExchangeReleaser'),
      contract('factory-abi', 'TokenJarFactory'),
    ],
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
        abiContractId: 'factory-abi',
      },
      {
        id: 'product-jar',
        kind: 'deploy',
        contractId: 'jar',
        strategy: { kind: 'plugin', pluginId: 'factory', producedBy: { stepId: 'call-factory', outputIndex: 0 } },
      },
      {
        id: 'product-releaser',
        kind: 'deploy',
        contractId: 'releaser',
        strategy: { kind: 'plugin', pluginId: 'factory', producedBy: { stepId: 'call-factory', outputIndex: 1 } },
      },
    ],
  };
}

function deps(types: DeploymentTypeInfo[] = [FACTORY_TYPE]): any {
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
          abi: [DEPLOY_FN],
          functionName: 'deploy',
          result: [JAR, RELEASER] as never,
        }),
      })),
    })),
    captureBundles: vi.fn(async () => ({})),
    resolveExplorers: vi.fn(async () => []),
    makeForkRunner: vi.fn(async () => undefined),
    deploymentTypes: { list: vi.fn(async () => types) } as never,
  };
}

describe('validating the canonical produced flow plan', () => {
  it('does not demand constructor arguments from produced products', async () => {
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({ ok: true });
  });

  it('surfaces every product prediction even with no create2 steps', async () => {
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, deps());
    const item = result.report.chains['1'].create2;
    expect(item).toMatchObject({ ok: true, message: 'Produced product addresses are expected' });
    const predicted = item?.details?.predicted as Record<
      string,
      { predictedAddress: string; provisional?: boolean }
    >;
    expect(predicted['product-jar'].predictedAddress.toLowerCase()).toBe(
      JAR.toLowerCase()
    );
    expect(predicted['product-jar'].provisional).toBe(true);
    expect(predicted['product-releaser'].predictedAddress.toLowerCase()).toBe(
      RELEASER.toLowerCase()
    );
  });

  it('still checks the arguments of the producer call itself', async () => {
    const missing = producedPlan();
    // salt is deliberately missing from the producer call.
    (missing.steps[0] as { args: Record<string, unknown> }).args = { owner: SIGNER };
    const result = await validatePlan(missing, { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'MISSING_ARGUMENT',
    });
  });
});

describe('structural produced-mode failures', () => {
  it('rejects a producedBy that names something other than a call step', async () => {
    const broken = producedPlan();
    ((broken.steps[2] as DeployStep).strategy as { producedBy: { stepId: string } }).producedBy.stepId = 'product-jar';
    const result = await validatePlan(broken, { '1': 'rpc-1' }, deps());
    // Dependency validation raises this first (the PRODUCED_PRODUCER_INVALID
    // branch inside the args walk is defence-in-depth behind it); what
    // matters is that the plan blocks with the producer named.
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'POINTER_TARGET_NOT_DEPLOY',
      message: expect.stringContaining('not a call step'),
    });
  });

  it('rejects an output index that is not an address output', async () => {
    const broken = producedPlan();
    ((broken.steps[2] as DeployStep).strategy as { producedBy: { outputIndex: number } }).producedBy.outputIndex = 5;
    const result = await validatePlan(broken, { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'PRODUCED_OUTPUT_NOT_ADDRESS',
    });
  });

  it('rejects two products claiming the same output', async () => {
    const broken = producedPlan();
    ((broken.steps[2] as DeployStep).strategy as { producedBy: { outputIndex: number } }).producedBy.outputIndex = 0;
    const result = await validatePlan(broken, { '1': 'rpc-1' }, deps());
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'PRODUCED_OUTPUT_DUPLICATE',
    });
  });
});

describe('deployment-type identity checks for plugin strategies', () => {
  it('blocks a produced step whose plugin declares create2 execution', async () => {
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, deps([
      { ...FACTORY_TYPE, execution: 'create2', composeSupported: false },
    ]));
    expect(result.report.chains['1'].create2).toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_TYPE_EXECUTION_MISMATCH',
    });
  });

  it('blocks a CREATE2-mode step whose plugin declares call-products execution', async () => {
    const create2Plan: DeploymentPlan = {
      ...producedPlan(),
      steps: [
        {
          id: 'product-jar',
          kind: 'deploy',
          contractId: 'jar',
          strategy: { kind: 'plugin', pluginId: 'factory', salt: `0x${'11'.repeat(32)}` },
        },
      ],
    };
    // The deterministic loop runs this identity check, so the client must at
    // least present the canonical proxy.
    const d = deps();
    d.createClient = vi.fn(() => ({
      estimateGas: vi.fn(async () => 100n),
      getBalance: vi.fn(async () => 10_000n),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
      getTransactionCount: vi.fn(async () => 0),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async ({ address }: { address: string }) =>
        address.toLowerCase() === CREATE2_PROXY_ADDRESS.toLowerCase()
          ? CREATE2_PROXY_RUNTIME_CODE
          : '0x'
      ),
      call: vi.fn(async () => ({ data: '0x' })),
    }));
    const result = await validatePlan(create2Plan, { '1': 'rpc-1' }, d);
    expect(result.report.chains['1'].create2).toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_TYPE_EXECUTION_MISMATCH',
      message: expect.stringContaining('is a CREATE2 deployment'),
    });
  });

  it('blocks a produced plan whose plugin is not installed', async () => {
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, deps([]));
    expect(result.report.chains['1'].create2).toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_TYPE_PLUGIN_MISSING',
    });
  });
});

describe('a produced prediction that fails', () => {
  // buildChainPredictions computes a `reason` for an absent entry and
  // validateCreate2 used to drop it on both paths it can take: the
  // produced-only early return, and the branch a plan also containing a
  // create2/plugin step falls into. Both must carry the reason through
  // `degraded` instead of erasing it.
  function revertingDeps(): ReturnType<typeof deps> {
    const d = deps();
    d.createClient = vi.fn(() => ({
      estimateGas: vi.fn(async () => 100n),
      getBalance: vi.fn(async () => 10_000n),
      estimateFeesPerGas: vi.fn(async () => ({
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
      })),
      getTransactionCount: vi.fn(async () => 0),
      getBlockNumber: vi.fn(async () => 1),
      getCode: vi.fn(async ({ address }: { address: string }) =>
        address.toLowerCase() === CREATE2_PROXY_ADDRESS.toLowerCase()
          ? CREATE2_PROXY_RUNTIME_CODE
          : '0x'
      ),
      call: vi.fn(async () => {
        throw new Error('execution reverted: not authorized');
      }),
    }));
    return d;
  }

  it('reports the revert reason instead of dropping the step (produced-only branch)', async () => {
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, revertingDeps());
    const details = result.report.chains['1'].create2!.details!;
    const degraded = (
      details.provisionalSteps as { stepId: string; degraded?: string }[]
    ).find((entry) => entry.stepId === 'product-jar');
    expect(degraded?.degraded).toContain('execution reverted');
  });

  it('does not claim addresses are predicted when every prediction failed', async () => {
    // The checklist message sits above the per-step rows, so announcing
    // predicted addresses over a list that is entirely "unavailable"
    // contradicts itself.
    const result = await validatePlan(producedPlan(), { '1': 'rpc-1' }, revertingDeps());
    const item = result.report.chains['1'].create2!;
    expect(item.details!.predicted).toEqual({});
    expect(item.message).toBe('Produced product addresses could not be predicted');
  });

  it('reports the revert reason alongside a create2 step (mixed branch)', async () => {
    const mixed = producedPlan();
    mixed.steps = [
      {
        id: 'static-jar',
        kind: 'deploy',
        contractId: 'jar',
        strategy: { kind: 'create2', salt: `0x${'11'.repeat(32)}` },
      },
      ...mixed.steps.filter((step) => step.id !== 'product-jar'),
    ];
    const result = await validatePlan(mixed, { '1': 'rpc-1' }, revertingDeps());
    const details = result.report.chains['1'].create2!.details!;
    const degraded = (
      details.provisionalSteps as { stepId: string; degraded?: string }[]
    ).find((entry) => entry.stepId === 'product-releaser');
    expect(degraded?.degraded).toContain('execution reverted');
  });
});

describe('a create2 deployment that consumes a produced product', () => {
  // The deterministic branch reads the canonical proxy, so the client must
  // present it while still simulating the producer call successfully.
  function proxyDeps(): ReturnType<typeof deps> {
    const d = deps();
    const base = d.createClient();
    d.createClient = vi.fn(() => ({
      ...base,
      getCode: vi.fn(async ({ address }: { address: string }) =>
        address.toLowerCase() === CREATE2_PROXY_ADDRESS.toLowerCase()
          ? CREATE2_PROXY_RUNTIME_CODE
          : '0x'
      ),
    }));
    return d;
  }
  function consumerPlan(order: 'after' | 'before-producer'): DeploymentPlan {
    const plan = producedPlan();
    plan.contracts = [...plan.contracts, contract('consumer', 'JarConsumer')];
    const consumer = {
      id: 'consumer',
      kind: 'deploy',
      contractId: 'consumer',
      strategy: { kind: 'create2', salt: `0x${'33'.repeat(32)}` },
      args: { jar: { $ref: { kind: 'step', stepId: 'product-jar' } } },
    } as unknown as DeployStep;
    plan.steps =
      order === 'after'
        ? [...plan.steps, consumer]
        : [consumer, ...plan.steps];
    return plan;
  }

  it('validates and predicts provisionally instead of blocking the plan', async () => {
    const result = await validatePlan(consumerPlan('after'), { '1': 'rpc-1' }, proxyDeps());
    const item = result.report.chains['1'].create2!;
    // The blocking CREATE2_PREDICTION_FAILED this used to raise made the whole
    // plan unlaunchable.
    expect(item).toMatchObject({ ok: true });
    expect(result.report.chains['1'].args).toMatchObject({ ok: true });
    const provisional = (
      item.details!.provisionalSteps as { stepId: string; predictedAddress?: string }[]
    ).find((entry) => entry.stepId === 'consumer');
    expect(provisional?.predictedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // A runtime-mined address is never a static commitment.
    expect(result.predicted?.['1']?.['consumer']).toBeUndefined();
  });

  it('blocks a reference made before the producer call has run', async () => {
    const result = await validatePlan(consumerPlan('before-producer'), { '1': 'rpc-1' }, proxyDeps());
    expect(result.report.chains['1'].args).toMatchObject({
      ok: false,
      code: 'CREATE2_POINTER_NOT_CONCRETE',
      // Step ids are labelled for the operator: the fix is to move the
      // reference after the producer call, so the message names it.
      message:
        'Create2 input args.jar references TokenJar, which is produced later by Call deploy(address,bytes32)',
    });
  });
});
