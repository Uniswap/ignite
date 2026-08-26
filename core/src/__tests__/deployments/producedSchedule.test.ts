import { describe, it, expect } from 'vitest';
import { encodeDeployData, encodeFunctionResult, type Abi, type AbiFunction } from 'viem';
import type { DeploymentPlan, FrozenInputs, Hex, Step } from '@ignite/api';
import {
  buildChainPredictions,
  buildSchedule,
  predictPlanAddresses,
} from '../../deployments/schedule.js';
import { initcodeHashOf, predictCreate2Address } from '../../deployments/create2.js';

const FACTORY = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6' as Hex;
const SIGNER = '0xde82fa0776824286f2a2e9c6445fc40c08422e97' as Hex;
const JAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
const RELEASER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Hex;
const CHAIN = 11155111;
// The canonical input-only form call steps store; names, outputs, and
// payability come from the frozen abiContractId ABI, never from this string.
const SIGNATURE = 'deploy(address,bytes32)';
const DEPLOY_FN: AbiFunction = {
  type: 'function',
  name: 'deploy',
  stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [
    { name: 'jar', type: 'address' },
    { name: 'releaser', type: 'address' },
  ],
};

// A consumer whose constructor actually takes the product's address: without
// a declared input the pointer would never be resolved into initcode at all.
const CONSUMER_CODE = '0x6083';
const CONSUMER_ABI = [
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'jar', type: 'address' }] },
] as unknown as Abi;
const CONSUMER_SALT = `0x${'33'.repeat(32)}` as Hex;

const frozen: FrozenInputs = {
  jar: { creationBytecode: '0x6080', abi: [] } as never,
  releaser: { creationBytecode: '0x6081', abi: [] } as never,
  'factory-abi': { creationBytecode: '0x6082', abi: [DEPLOY_FN] } as never,
  consumer: { creationBytecode: CONSUMER_CODE, abi: CONSUMER_ABI } as never,
};

/** One producer call paying value, and two products produced by it. */
function plan(overrides: { products?: Step[]; extraSteps?: Step[] } = {}): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [{ id: 'jar' }, { id: 'releaser' }, { id: 'factory-abi' }, { id: 'consumer' }] as never,
    chains: [CHAIN],
    signers: {
      global: { pluginId: 'private-key', accountId: 'k', address: SIGNER } as never,
    },
    steps: [
      {
        id: 'call-factory',
        kind: 'call',
        target: { kind: 'address', address: FACTORY },
        signature: SIGNATURE,
        payable: true,
        value: '7',
        args: { owner: SIGNER, salt: `0x${'11'.repeat(32)}` },
        abiContractId: 'factory-abi',
      },
      ...(overrides.products ?? [
        product('product-jar', 'jar', 0),
        product('product-releaser', 'releaser', 1),
      ]),
      ...(overrides.extraSteps ?? []),
    ] as never,
  };
}
function product(id: string, contractId: string, outputIndex: number, producerId = 'call-factory'): Step {
  return {
    id,
    kind: 'deploy',
    contractId,
    strategy: { kind: 'plugin', pluginId: 'factory', producedBy: { stepId: producerId, outputIndex } },
  } as Step;
}

function client(calls: Array<{ to: Hex; data: Hex; account?: Hex; value?: bigint }>) {
  return {
    getTransactionCount: async () => 0,
    call: async (args: { to: Hex; data: Hex; account?: Hex; value?: bigint }) => {
      calls.push(args);
      return {
        data: encodeFunctionResult({
          abi: [DEPLOY_FN],
          functionName: 'deploy',
          result: [JAR, RELEASER] as never,
        }),
      };
    },
  };
}

const signers = new Map<string, Hex>([
  ['call-factory', SIGNER],
  ['product-jar', SIGNER],
  ['product-releaser', SIGNER],
]);
const address = (snapshot: Awaited<ReturnType<typeof buildChainPredictions>>, id: string) => {
  const entry = snapshot.entries[id];
  return entry && 'predictedAddress' in entry ? entry.predictedAddress.toLowerCase() : undefined;
};
const reason = (snapshot: Awaited<ReturnType<typeof buildChainPredictions>>, id: string) => {
  const entry = snapshot.entries[id];
  return entry && 'absent' in entry ? entry.reason : undefined;
};

describe('predicting produced products from the producer call', () => {
  // One call creates every product, so one simulation predicts them all —
  // products naming the same producer share its result rather than calling
  // again.
  it('groups all products of one producer into a single eth_call', async () => {
    const calls: Array<{ to: Hex; data: Hex; account?: Hex; value?: bigint }> = [];
    const snapshot = await buildChainPredictions(plan(), frozen, CHAIN, {
      client: client(calls),
      signers,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(FACTORY);
    expect(address(snapshot, 'product-jar')).toBe(JAR.toLowerCase());
    expect(address(snapshot, 'product-releaser')).toBe(RELEASER.toLowerCase());
  });

  // Sender-scoped factories (salt schemes) and paying producers derive
  // different products for a different from or value, so the simulation must
  // carry the exact transaction the run would send.
  it('passes the producer signer and call value into the simulation', async () => {
    const calls: Array<{ to: Hex; data: Hex; account?: Hex; value?: bigint }> = [];
    await buildChainPredictions(plan(), frozen, CHAIN, { client: client(calls), signers });
    expect(calls[0].account).toBe(SIGNER);
    expect(calls[0].value).toBe(7n);
  });

  it('labels every produced prediction with the producer signature', async () => {
    const snapshot = await buildChainPredictions(plan(), frozen, CHAIN, {
      client: client([]),
      signers,
    });
    const entry = snapshot.entries['product-jar'];
    expect(entry && 'notes' in entry ? entry.notes : undefined).toEqual([
      `returned by ${SIGNATURE}`,
    ]);
    expect(entry && 'provisional' in entry ? entry.provisional : undefined).toBe(true);
  });

  it('excludes produced products from static commitments', async () => {
    const withCreate2 = plan({ extraSteps: [
      { id: 'static', kind: 'deploy', contractId: 'jar', strategy: { kind: 'create2', salt: `0x${'22'.repeat(32)}` } } as Step,
    ] });
    const snapshot = await buildChainPredictions(withCreate2, frozen, CHAIN, {
      client: client([]),
      signers: new Map([...signers, ['static', SIGNER]]),
    });
    // Lane seeding is static-only; a produced address must never become an
    // execution commitment through the predictions map.
    expect(Object.keys(snapshot.predictions)).toEqual(['static']);
    expect(address(snapshot, 'product-jar')).toBe(JAR.toLowerCase());
  });

  // The jar-then-releaser shape: a CREATE2 deployment whose constructor takes
  // a product's address. Static prediction cannot resolve that pointer, so
  // before products were classified runtime-dynamic predictPlanAddresses threw
  // "Unable to resolve create2 predictions after dependency validation" and no
  // such plan could ever launch.
  it('predicts a create2 consumer of a product at run time, not statically', async () => {
    const consumer = {
      id: 'consumer', kind: 'deploy', contractId: 'consumer',
      strategy: { kind: 'create2', salt: CONSUMER_SALT },
      args: { jar: { $ref: { kind: 'step', stepId: 'product-jar' } } },
    } as unknown as Step;
    const target = plan({ extraSteps: [consumer] });
    expect(predictPlanAddresses(target, frozen, CHAIN)).toEqual({});
    const snapshot = await buildChainPredictions(target, frozen, CHAIN, {
      client: client([]),
      signers: new Map([...signers, ['consumer', SIGNER]]),
    });
    // Products are omitted from the mined-provisional set: they have no salt
    // to mine and are predicted through the producer call above.
    expect(snapshot.dynamic).toEqual(new Set(['consumer']));
    expect(Object.keys(snapshot.predictions)).toEqual([]);
    const entry = snapshot.entries['consumer'];
    expect(entry).toMatchObject({ provisional: true });
    // Proves the simulated product address is what went into the initcode.
    expect(address(snapshot, 'consumer')).toBe(
      predictCreate2Address(
        CONSUMER_SALT as never,
        initcodeHashOf(encodeDeployData({ abi: CONSUMER_ABI, bytecode: CONSUMER_CODE, args: [JAR] }))
      ).toLowerCase()
    );
  });

  it('reports bounded reasons for every degraded prediction', async () => {
    // No RPC client at all.
    const offline = await buildChainPredictions(plan(), frozen, CHAIN, { signers });
    for (const id of ['product-jar', 'product-releaser'])
      expect(reason(offline, id)).toMatch(/RPC/i);

    // The producer exists but makes no call (a call step with no signature).
    const bare = plan({ products: [product('product-jar', 'jar', 0, 'bare-call')] });
    bare.steps = [
      { id: 'bare-call', kind: 'call', target: { kind: 'address', address: FACTORY } } as Step,
      ...bare.steps.slice(1),
    ];
    const notACall = await buildChainPredictions(bare, frozen, CHAIN, {
      client: client([]),
      signers: new Map([['bare-call', SIGNER], ['product-jar', SIGNER]]),
    });
    expect(reason(notACall, 'product-jar')).toMatch(/does not make a producer call/);

    // The simulation itself fails.
    const reverted = await buildChainPredictions(plan(), frozen, CHAIN, {
      client: {
        getTransactionCount: async () => 0,
        call: async () => {
          throw new Error('execution reverted: not authorized');
        },
      },
      signers,
    });
    expect(reason(reverted, 'product-jar')).toContain('execution reverted');

    // The call succeeds but has no address at the claimed output index.
    const missingOutput = plan({ products: [product('product-jar', 'jar', 5)] });
    const truncated = await buildChainPredictions(missingOutput, frozen, CHAIN, {
      client: client([]),
      signers,
    });
    expect(reason(truncated, 'product-jar')).toContain('no address at output 5');
  });
});

describe('scheduling a producer call and its products', () => {
  it('sends only the producer call, and both products carry their addresses', async () => {
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
    expect(schedule.filter((entry) => entry.kind === 'tx')).toHaveLength(1);
    expect(schedule.find((entry) => entry.stepId === 'call-factory')?.to).toBe(FACTORY);
    for (const [id, expected] of [
      ['product-jar', JAR],
      ['product-releaser', RELEASER],
    ] as const) {
      const entry = schedule.find((item) => item.stepId === id);
      expect(entry?.kind).toBe('existing');
      expect(entry?.predictedAddress?.toLowerCase()).toBe(expected.toLowerCase());
    }
  });

  it('schedules a bare existing entry when no provisional prediction is supplied', () => {
    // Static prediction cannot know a produced address, so the entry stays an
    // honest placeholder instead of inventing one.
    const schedule = buildSchedule(plan(), frozen, CHAIN, { signers });
    const entry = schedule.find((item) => item.stepId === 'product-jar');
    expect(entry).toEqual({ stepId: 'product-jar', kind: 'existing' });
  });
});
