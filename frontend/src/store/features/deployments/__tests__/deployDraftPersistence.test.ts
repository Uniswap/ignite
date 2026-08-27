// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ComposedCallProducts, ContractSource, DeploymentTypeBinding } from '@ignite/api';
import {
  deployDraftReducer,
  addCallStep,
  addContracts,
  seedDraft,
  selectContractType,
  setCallStepField,
  setLibraries,
  setStrategy,
  toggleChain,
  startComposition,
  setCompositionArtifact,
  setCompositionValue,
  applyComposition,
} from '../deployDraftSlice';
import {
  DEPLOY_DRAFT_STORAGE_KEY,
  loadDraft,
  saveDraft,
} from '../deployDraftPersistence';

function contract(id: string, contractName: string): ContractSource {
  return {
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `out/${contractName}.sol/${contractName}.json`,
    contractName,
    sourcePath: `src/${contractName}.sol`,
  };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => map.delete(key),
  };
}

function draftWithContracts() {
  let state = deployDraftReducer(
    undefined,
    addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
  );
  state = deployDraftReducer(state, toggleChain(1));
  return state;
}

describe('deployDraftPersistence', () => {
  it('round-trips a draft through storage', () => {
    const storage = fakeStorage();
    const draft = draftWithContracts();

    saveDraft(draft, storage);

    expect(loadDraft(storage)).toEqual(draft);
  });

  it('round-trips synthesized wrapper state, including the explicit empty initializer choice', () => {
    const storage = fakeStorage();
    let draft = deployDraftReducer(undefined, seedDraft([contract('token', 'Token')]));
    draft = deployDraftReducer(draft, selectContractType({
      implementationStepId: 'deploy-token',
      contractType: {
        pluginId: 'transparent', label: 'Transparent proxy', description: 'test', versionLabel: 'OZ 5.3.0', contentHash: 'a'.repeat(64), params: [], artifacts: ['proxy'],
        synthesis: { artifact: 'proxy', constructorArgs: [{ name: '_logic', from: 'implementation' }, { name: '_data', from: 'initializer' }] }, validation: {}, capture: [],
      },
      artifact: { sourceIdentifier: 'Proxy.sol:TransparentUpgradeableProxy' },
    }));
    const wrapper = draft.steps.find((step) => step.kind === 'deploy' && step.wraps)!;
    draft = deployDraftReducer(draft, { type: 'deployDraft/setWrapperInitializer', payload: { stepId: wrapper.id, key: '_data', value: '0x', selection: '' } });
    saveDraft(draft, storage);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('stores plugin parameter values under their synthesized constructor argument names', () => {
    let draft = deployDraftReducer(undefined, seedDraft([contract('token', 'Token')]));
    draft = deployDraftReducer(draft, selectContractType({ implementationStepId: 'deploy-token', contractType: { pluginId: 'custom', label: 'Custom', description: 'test', versionLabel: 'v1', contentHash: 'a'.repeat(64), params: [{ key: 'initialOwner', label: 'Owner', type: 'address', required: true }], artifacts: ['proxy'], synthesis: { artifact: 'proxy', constructorArgs: [{ name: 'owner_', from: 'param', param: 'initialOwner' }] }, validation: {}, capture: [] }, artifact: { sourceIdentifier: 'Proxy.sol:Proxy' } }));
    const wrapper = draft.steps.find((step) => step.kind === 'deploy' && step.wraps)!;
    draft = deployDraftReducer(draft, { type: 'deployDraft/setArg', payload: { stepId: wrapper.id, key: 'owner_', value: '0x1111111111111111111111111111111111111111' } });
    expect(wrapper.args?.initialOwner).toBeUndefined();
    expect(draft.steps.find((step) => step.id === wrapper.id)?.args).toMatchObject({ owner_: '0x1111111111111111111111111111111111111111' });
  });

  it('clears initializer overrides and native value when switching to a nonpayable initializer', () => {
    let draft = deployDraftReducer(undefined, seedDraft([contract('token', 'Token')]));
    draft = deployDraftReducer(draft, selectContractType({ implementationStepId: 'deploy-token', contractType: { pluginId: 'proxy', label: 'Proxy', description: 'test', versionLabel: 'v1', contentHash: 'a'.repeat(64), params: [], artifacts: ['proxy'], synthesis: { artifact: 'proxy', constructorArgs: [{ name: '_data', from: 'initializer' }] }, validation: {}, capture: [] }, artifact: {} }));
    const wrapper = draft.steps.find((step) => step.kind === 'deploy' && step.wraps)!;
    draft = deployDraftReducer(draft, { type: 'deployDraft/setChainArgOverride', payload: { stepId: wrapper.id, chainId: 1, key: '_data', value: { $encode: { contractId: 'token', fn: 'payableInit()', args: {} } } } });
    draft = deployDraftReducer(draft, { type: 'deployDraft/setValue', payload: { stepId: wrapper.id, value: '1' } });
    draft = deployDraftReducer(draft, { type: 'deployDraft/setValuePerChain', payload: { stepId: wrapper.id, chainId: 1, value: '2' } });
    draft = deployDraftReducer(draft, { type: 'deployDraft/setWrapperInitializer', payload: { stepId: wrapper.id, key: '_data', selection: 'initialize()', payable: false, value: { $encode: { contractId: 'token', fn: 'initialize()', args: {} } } } });
    const changed = draft.steps.find((step) => step.id === wrapper.id)!;
    expect(changed).not.toHaveProperty('argsPerChain');
    expect(changed).not.toHaveProperty('value');
    expect(changed).not.toHaveProperty('valuePerChain');
  });

  it('restores a pre-D6 v2 draft unchanged when additive workflow fields are absent', () => {
    const draft = draftWithContracts();
    const storage = fakeStorage({ [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(draft) });
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('returns undefined when nothing is stored', () => {
    expect(loadDraft(fakeStorage())).toBeUndefined();
  });

  it('returns undefined for corrupt JSON', () => {
    const storage = fakeStorage({ [DEPLOY_DRAFT_STORAGE_KEY]: '{not json' });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('discards the incompatible v1 and v2 session keys', () => {
    const storage = fakeStorage({
      'ignite.deployDraft.v1': JSON.stringify(draftWithContracts()),
      'ignite.deployDraft.v2': JSON.stringify(draftWithContracts()),
    });
    expect(loadDraft(storage)).toBeUndefined();
    expect(storage.getItem('ignite.deployDraft.v1')).toBeNull();
    expect(storage.getItem('ignite.deployDraft.v2')).toBeNull();
  });

  it('rejects parseable payloads with orphaned steps', () => {
    const draft = draftWithContracts();
    const broken = { ...draft, contracts: [draft.contracts[0]] };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects unseen ids that reference no contract', () => {
    const draft = { ...draftWithContracts(), unseenIds: ['ghost'] };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(draft),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects configuration without contracts', () => {
    // Config-only drafts are not a session (spec edge case): they must not
    // be restored and inherited by the next deployment's first add.
    let empty = deployDraftReducer(undefined, { type: 'noop' });
    empty = deployDraftReducer(empty, toggleChain(1));
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(empty),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects duplicate step ids', () => {
    const draft = draftWithContracts();
    const broken = {
      ...draft,
      // Two distinct contracts whose steps share one id: unique-contractId
      // checks pass, but downstream step lookups and React keys would break.
      steps: draft.steps.map((step) => ({ ...step, id: 'deploy-token' })),
    };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('rejects duplicate contract ids', () => {
    const draft = draftWithContracts();
    const broken = {
      ...draft,
      contracts: [draft.contracts[0], draft.contracts[0]],
    };
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify(broken),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });

  it('swallows storage write failures', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => saveDraft(draftWithContracts(), storage)).not.toThrow();
  });

  it('round-trips a materialized composition draft', () => {
    const storage = fakeStorage();
    let draft = deployDraftReducer(undefined, startComposition('call-products-plugin'));
    draft = deployDraftReducer(
      draft,
      setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
    );
    draft = deployDraftReducer(
      draft,
      setCompositionValue({ key: 'address', value: `0x${'21'.repeat(20)}` })
    );
    draft = deployDraftReducer(
      draft,
      setCompositionArtifact({ key: 'product.jar', source: contract('jar-art', 'TokenJar') })
    );
    const binding: DeploymentTypeBinding = {
      pluginId: 'call-products-plugin',
      pluginVersion: '1.0.0',
      execution: 'call-products',
      descriptorHash: 'a'.repeat(64),
    };
    const composition: ComposedCallProducts = {
      producer: {
        abiArtifactField: 'producer',
        targetField: 'address',
        functionField: 'function',
        signature: 'deploy(bytes32)',
        payable: false,
      },
      products: [{ key: 'jar', artifactField: 'product.jar', outputIndex: 0 }],
    };
    draft = deployDraftReducer(draft, applyComposition({ binding, composition }));
    // One product plus the never-deployed frozen producer ABI source.
    expect(draft.contracts.length).toBe(2);

    saveDraft(draft, storage);

    expect(loadDraft(storage)).toEqual(draft);
  });

  it('restores an incomplete composition without contracts', () => {
    // The zero-contract rule is deliberately relaxed here: an in-progress
    // composer session must survive a reload, and it cannot leak dormant
    // configuration because the wizard cannot pass the composer station
    // without materializing contracts.
    const storage = fakeStorage();
    let draft = deployDraftReducer(undefined, startComposition('call-products-plugin'));
    draft = deployDraftReducer(
      draft,
      setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
    );
    draft = deployDraftReducer(
      draft,
      setCompositionValue({ key: 'address', value: `0x${'21'.repeat(20)}` })
    );
    saveDraft(draft, storage);
    expect(loadDraft(storage)).toEqual(draft);
  });

  it('still refuses configuration without contracts or a composition', () => {
    const storage = fakeStorage();
    const broken = { ...draftWithContracts(), contracts: [], steps: [], deployExtras: {} };
    saveDraft(broken, storage);
    expect(loadDraft(storage)).toBeUndefined();
  });

  // Every keystroke in an address, salt or library field lands in the draft and
  // is persisted synchronously, so parsing those with the plan's strict schemas
  // discarded the whole session — composition, contracts, chains, signers and
  // args — for one half-typed character.
  it('restores a session whose addresses and salt are still half-typed', () => {
    const storage = fakeStorage();
    let draft = deployDraftReducer(undefined, seedDraft([contract('token', 'Token')]));
    draft = deployDraftReducer(draft, addCallStep(0));
    const callId = draft.steps[1].id;
    draft = deployDraftReducer(
      draft,
      setCallStepField({
        id: callId,
        patch: {
          target: { kind: 'address', address: '0x2179a6' as `0x${string}` },
          // The cleared-field sentinel the per-chain input writes is not an
          // address either.
          targetPerChain: { '1': { kind: 'address', address: '0x' as `0x${string}` } },
        },
      })
    );
    draft = deployDraftReducer(
      draft,
      setStrategy({
        stepId: 'deploy-token',
        strategy: { kind: 'create2', salt: '0x12ab' as `0x${string}` },
      })
    );
    draft = deployDraftReducer(
      draft,
      setLibraries({
        stepId: 'deploy-token',
        libraries: { Math: { kind: 'address', address: '0xab' as `0x${string}` } },
      })
    );

    saveDraft(draft, storage);

    expect(loadDraft(storage)).toEqual(draft);
  });

  it('keeps server-supplied predictions strict', () => {
    // Prepared values are never typed: a corrupted one is dropped rather than
    // restored and shown as a prediction.
    const draft = draftWithContracts();
    const storage = fakeStorage({
      [DEPLOY_DRAFT_STORAGE_KEY]: JSON.stringify({
        ...draft,
        deployExtras: {
          'deploy-token': {
            strategy: { kind: 'create2' },
            prepared: { '1': { salt: '0x12', predictedAddress: '0x34', initcodeHash: '0x56', notes: [] } },
          },
        },
      }),
    });
    expect(loadDraft(storage)).toBeUndefined();
  });
});
