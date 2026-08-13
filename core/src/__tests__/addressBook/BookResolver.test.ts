import { describe, expect, it } from 'vitest';
import type { DeploymentPlan, FrozenInputs } from '@ignite/api';
import { resolveBookPointers } from '../../addressBook/BookResolver.js';

const address = '0x1234567890AbcdEF1234567890aBcdef12345678' as const;
const hash = 'a'.repeat(64);

function plan(value: unknown): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [{ id: 'contract', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: 'Counter.json', contractName: 'Counter', sourcePath: 'src/Counter.sol' }],
    steps: [{ id: 'deploy', kind: 'deploy', contractId: 'contract', args: { recipient: value } }],
    chains: [1, 10],
    signers: {},
  };
}

const frozen: FrozenInputs = {
  contract: { abi: [{ type: 'constructor', inputs: [{ name: 'recipient', type: 'address' }] }], creationBytecode: '0x00', compiler: { pluginId: 'foundry', version: '1', settingsHash: hash }, artifactHash: hash, repoDirty: false },
};

const books = {
  contextual: async (_profileId: string, _workflow?: { repoPathOrUrl: string }) => ({ source: 'local' as const, sourceKey: 'local', bookHash: hash, file: { schemaVersion: 1 as const, entries: [{ name: 'treasury', perChain: { '1': address, '10': '0x876543210fedCBA9876543210fEdcba987654321' as const } }] } }),
};

describe('book pointer resolution', () => {
  it('freezes a distinct per-chain literal and records provenance', async () => {
    const result = await resolveBookPointers(plan({ $book: { name: 'treasury' } }), frozen, 'profile', undefined, { books });
    expect(result.plan.steps[0]).toMatchObject({ args: {}, argsPerChain: { '1': { recipient: address }, '10': { recipient: '0x876543210FedCBa9876543210fedcBA987654321' } } });
    expect(result.bookResolutions?.['1']?.[0]).toMatchObject({ entry: 'treasury', source: 'local', bookHash: hash });
  });

  it('rejects a pointer outside an address ABI position with its path', async () => {
    const numericFrozen = { contract: { ...frozen.contract, abi: [{ type: 'constructor', inputs: [{ name: 'recipient', type: 'uint256' }] }] } } as FrozenInputs;
    await expect(resolveBookPointers(plan({ $book: { name: 'treasury' } }), numericFrozen, 'profile', undefined, { books })).rejects.toMatchObject({ code: 'BOOK_POINTER_INVALID_POSITION', details: { stepId: 'deploy', argPath: 'args.recipient' } });
  });
});
