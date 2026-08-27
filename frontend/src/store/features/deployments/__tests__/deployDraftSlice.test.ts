// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type {
  ComposedCallProducts,
  ContractSource,
  DeploymentTypeBinding,
  WorkflowDocument,
} from '@ignite/api';
import {
  deployDraftReducer,
  hydrateWorkflowDraft,
  producedStepIdsFor,
  setValue,
  setValuePerChain,
  toggleWorkflowStep,
  workflowDependentsForExclusion,
  seedDraft,
  setChainArgOverride,
  moveStep,
  addContracts,
  removeContract,
  markDraftSeen,
  draftLaunched,
  mintIdempotencyKey,
  toggleChain,
  setName,
  deployDraftInitialState,
  addCallStep,
  acknowledgeDeployed,
  ackStale,
  removeCallStep,
  setArg,
  setLibraries,
  setPluginParams,
  setStrategy,
  setStepSigner,
  storePrepared,
  startComposition,
  compositionInProgress,
  compositionMaterializationProblem,
  setCompositionArtifact,
  setCompositionValue,
  applyComposition,
} from '../deployDraftSlice';
import { contractSourceId } from '../../../../utils/contractSourceId';

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

describe('deployDraftSlice', () => {
  const hex = (character: string) =>
    `0x${character.repeat(64)}` as `0x${string}`;
  function preparedState() {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token'), contract('vault', 'Vault')])
    );
    state = deployDraftReducer(
      state,
      setStrategy({
        stepId: 'deploy-token',
        strategy: { kind: 'plugin', pluginId: 'deterministic' },
      })
    );
    state = deployDraftReducer(
      state,
      setLibraries({
        stepId: 'deploy-vault',
        libraries: { token: { kind: 'step', stepId: 'deploy-token' } },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x1111111111111111111111111111111111111111',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-vault',
        chains: {
          '1': {
            salt: hex('3'),
            predictedAddress: '0x2222222222222222222222222222222222222222',
            initcodeHash: hex('4'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(
      state,
      acknowledgeDeployed({
        stepId: 'deploy-token',
        chainId: 1,
        predictedAddress: '0x1111111111111111111111111111111111111111',
        initcodeHash: hex('2'),
      })
    );
    state = deployDraftReducer(
      state,
      acknowledgeDeployed({
        stepId: 'deploy-vault',
        chainId: 1,
        predictedAddress: '0x2222222222222222222222222222222222222222',
        initcodeHash: hex('4'),
      })
    );
    return state;
  }

  it('invalidates transitive prepared predictions and prunes acknowledgements', () => {
    const state = deployDraftReducer(
      preparedState(),
      setArg({
        stepId: 'deploy-token',
        key: 'owner',
        value: '0x1111111111111111111111111111111111111111',
      })
    );
    expect(state.deployExtras['deploy-token']).toMatchObject({
      needsPrepare: true,
    });
    expect(state.deployExtras['deploy-token'].prepared).toBeUndefined();
    expect(state.deployExtras['vault']).toBeUndefined();
    expect(state.deployExtras['deploy-vault'].prepared).toBeUndefined();
    expect(state.deployExtras['deploy-vault'].acknowledged).toBeUndefined();
  });

  it('invalidates strategy, salt, library, and plugin parameter edits', () => {
    for (const action of [
      setStrategy({ stepId: 'deploy-token', strategy: { kind: 'create2' } }),
      setLibraries({
        stepId: 'deploy-token',
        libraries: {
          x: {
            kind: 'address',
            address: '0x1111111111111111111111111111111111111111',
          },
        },
      }),
      setPluginParams({ stepId: 'deploy-token', params: { network: 'test' } }),
    ]) {
      const state = deployDraftReducer(preparedState(), action);
      expect(state.deployExtras['deploy-token'].prepared).toBeUndefined();
      expect(state.deployExtras['deploy-token'].acknowledged).toBeUndefined();
    }
  });

  it('removing a referenced call nulls dangling refs and invalidates dependents', () => {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addCallStep(0));
    const call = state.steps[1];
    state = deployDraftReducer(
      state,
      setArg({
        stepId: 'deploy-token',
        key: 'recipient',
        value: { $ref: { kind: 'step', stepId: call.id } },
      })
    );
    state = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x1111111111111111111111111111111111111111',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    state = deployDraftReducer(state, removeCallStep(call.id));
    expect(state.steps[0].args?.recipient).toBeUndefined();
    expect(state.deployExtras['deploy-token']?.prepared).toBeUndefined();
  });

  it('reports acknowledgement staleness from the current prepared commitment', () => {
    const state = preparedState();
    expect(ackStale(state, 'deploy-token', 1)).toBe(false);
    const changed = deployDraftReducer(
      state,
      storePrepared({
        stepId: 'deploy-token',
        chains: {
          '1': {
            salt: hex('1'),
            predictedAddress: '0x3333333333333333333333333333333333333333',
            initcodeHash: hex('2'),
            notes: [],
          },
        },
      })
    );
    expect(ackStale(changed, 'deploy-token', 1)).toBe(true);
  });
  it('seeds two contracts and their deployment steps in source order', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];

    const state = deployDraftReducer(undefined, seedDraft(contracts));

    expect(state.contracts).toEqual(contracts);
    expect(state.steps).toEqual([
      { id: 'deploy-token', kind: 'deploy', contractId: 'token' },
      { id: 'deploy-vault', kind: 'deploy', contractId: 'vault' },
    ]);
  });

  it('keeps two pinned versions of the same contract as separate draft rows', () => {
    const pinned = (commit: string): ContractSource => {
      const source = {
        repoPathOrUrl: 'https://example.test/contracts.git',
        frameworkId: 'foundry',
        artifactPath: 'out/Token.sol/Token.json',
        contractName: 'Token',
        sourcePath: 'src/Token.sol',
        pin: { url: 'https://example.test/contracts.git', commit },
      };
      return { id: contractSourceId(source), ...source };
    };
    const first = pinned('a'.repeat(40));
    const second = pinned('b'.repeat(40));

    let state = deployDraftReducer(undefined, addContracts([first]));
    state = deployDraftReducer(state, addContracts([second]));

    expect(state.contracts).toEqual([first, second]);
    expect(state.contracts.map((contract) => contract.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(state.steps.map((step) => step.contractId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('retains a pinned source when adding it to a deployment draft', () => {
    const source = {
      repoPathOrUrl: 'https://example.test/contracts.git', frameworkId: 'foundry',
      artifactPath: 'out/Token.sol/Token.json', contractName: 'Token', sourcePath: 'src/Token.sol',
      pin: { url: 'https://example.test/contracts.git', commit: 'c'.repeat(40), ref: 'v1.2.3' },
    };
    const contract = { id: contractSourceId(source), ...source };
    const state = deployDraftReducer(undefined, addContracts([contract]));
    expect(state.contracts[0]).toMatchObject({ id: contract.id, pin: source.pin });
  });

  it('sets and clears sparse per-chain argument overrides', () => {
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      setChainArgOverride({
        stepId: 'deploy-token',
        chainId: 11155111,
        key: 'owner',
        value: '0x1111111111111111111111111111111111111111',
      })
    );
    expect(state.steps[0].argsPerChain).toEqual({
      '11155111': {
        owner: '0x1111111111111111111111111111111111111111',
      },
    });

    state = deployDraftReducer(
      state,
      setChainArgOverride({
        stepId: 'deploy-token',
        chainId: 11155111,
        key: 'owner',
        value: undefined,
      })
    );
    expect(state.steps[0].argsPerChain).toBeUndefined();
  });

  it('stores a step signer cascade with per-chain entries', () => {
    const signer = {
      pluginId: 'wallet',
      accountId: 'main',
      address: '0x1111111111111111111111111111111111111111',
    } as const;
    const cascade = { perChain: { '1': signer, '10': signer } };
    const state = deployDraftReducer(
      deployDraftReducer(undefined, seedDraft([contract('token', 'Token')])),
      setStepSigner({ stepId: 'deploy-token', cascade })
    );

    expect(state.steps[0].signerOverride).toEqual(cascade);
  });

  it('removing a chain prunes step signer overrides for that chain', () => {
    const signer = {
      pluginId: 'wallet',
      accountId: 'main',
      address: '0x1111111111111111111111111111111111111111',
    } as const;
    let state = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, addCallStep(0));
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(state, toggleChain(10));
    state = deployDraftReducer(
      state,
      setStepSigner({
        stepId: 'deploy-token',
        cascade: { perChain: { '1': signer } },
      })
    );
    state = deployDraftReducer(
      state,
      setStepSigner({
        stepId: state.steps[1].id,
        cascade: { global: signer, perChain: { '1': signer, '10': signer } },
      })
    );

    state = deployDraftReducer(state, toggleChain(1));

    expect(state.steps[0].signerOverride).toBeUndefined();
    expect(state.steps[1].signerOverride).toEqual({
      global: signer,
      perChain: { '10': signer },
    });
  });

  it('moves execution steps without changing the contract inventory', () => {
    const contracts = [contract('token', 'Token'), contract('vault', 'Vault')];
    const state = deployDraftReducer(
      deployDraftReducer(undefined, seedDraft(contracts)),
      moveStep({ fromIndex: 1, toIndex: 0 })
    );

    expect(state.steps.map((step) => step.contractId)).toEqual([
      'vault',
      'token',
    ]);
    expect(state.contracts.map((contract) => contract.id)).toEqual([
      'token',
      'vault',
    ]);
  });

  it('addContracts appends and dedupes by id', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
    );

    expect(state.contracts.map((c) => c.id)).toEqual(['token', 'vault']);
    expect(state.steps.map((s) => s.id)).toEqual([
      'deploy-token',
      'deploy-vault',
    ]);
  });

  it('first add into an empty draft records no unseen ids; later adds do', () => {
    // The first add navigates the user into the wizard, so those contracts
    // are seen by definition; only additions to an already-active draft
    // surface via the badge.
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    expect(state.unseenIds).toEqual([]);

    state = deployDraftReducer(
      state,
      addContracts([contract('token', 'Token'), contract('vault', 'Vault')])
    );
    expect(state.unseenIds).toEqual(['vault']);
  });

  it('addContracts preserves existing configuration', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );

    expect(state.chains).toEqual([1]);
    expect(state.contracts).toHaveLength(2);
  });

  it('markDraftSeen clears unseen ids without touching contracts', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );
    expect(state.unseenIds).toEqual(['vault']);

    state = deployDraftReducer(state, markDraftSeen());

    expect(state.unseenIds).toEqual([]);
    expect(state.contracts).toHaveLength(2);
  });

  it('removeContract drops the contract, its step, and its unseen entry', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(
      state,
      addContracts([contract('vault', 'Vault')])
    );
    state = deployDraftReducer(state, removeContract('vault'));

    expect(state.contracts.map((c) => c.id)).toEqual(['token']);
    expect(state.steps.map((s) => s.contractId)).toEqual(['token']);
    expect(state.unseenIds).toEqual([]);
  });

  it('removing the last contract resets the entire draft', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, toggleChain(1));
    state = deployDraftReducer(state, setName('leftovers'));
    state = deployDraftReducer(state, removeContract('token'));

    expect(state).toEqual(deployDraftInitialState);
  });

  it('removeContract ignores unknown ids', () => {
    const seeded = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    const state = deployDraftReducer(seeded, removeContract('ghost'));

    expect(state).toEqual(seeded);
  });

  it('draftLaunched clears only the draft that was launched', () => {
    let state = deployDraftReducer(
      undefined,
      addContracts([contract('token', 'Token')])
    );
    state = deployDraftReducer(state, mintIdempotencyKey());
    const launchedKey = state.idempotencyKey!;

    // A stale launch response (user discarded and started a new draft with a
    // different key) must not wipe the current draft.
    const untouched = deployDraftReducer(state, draftLaunched('other-key'));
    expect(untouched).toEqual(state);

    const cleared = deployDraftReducer(state, draftLaunched(launchedKey));
    expect(cleared).toEqual(deployDraftInitialState);
  });
});

describe('deployment composer flow', () => {
  const PRODUCER_ADDRESS = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6';
  // Canonical input-only form — exactly what ordinary call steps store.
  const SIGNATURE = 'deploy(address,bytes32)';
  const PLUGIN_ID = 'call-products-plugin';
  const jarArtifact = contract('jar-art', 'TokenJar');
  const releaserArtifact = contract('rel-art', 'ExchangeReleaser');
  const binding: DeploymentTypeBinding = {
    pluginId: PLUGIN_ID,
    pluginVersion: '1.0.0',
    execution: 'call-products',
    descriptorHash: 'a'.repeat(64),
  };

  function composed(
    products: ComposedCallProducts['products']
  ): ComposedCallProducts {
    return {
      producer: {
        abiArtifactField: 'producer',
        targetField: 'address',
        functionField: 'function',
        signature: SIGNATURE,
        payable: false,
      },
      products,
    };
  }
  const TWO_PRODUCTS = composed([
    { key: 'jar', artifactField: 'product.jar', outputIndex: 0 },
    { key: 'releaser', artifactField: 'product.releaser', outputIndex: 1 },
  ]);

  function setupState() {
    let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
    );
    state = deployDraftReducer(
      state,
      setCompositionValue({ key: 'address', value: PRODUCER_ADDRESS })
    );
    state = deployDraftReducer(
      state,
      setCompositionValue({ key: 'function', value: SIGNATURE })
    );
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.jar', source: jarArtifact })
    );
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.releaser', source: releaserArtifact })
    );
    return state;
  }

  it('startComposition seeds an empty draft with a minted composition id', () => {
    const state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    expect(state.contracts).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.composition).toMatchObject({
      pluginId: PLUGIN_ID,
      values: {},
      artifacts: {},
      ownedContractIds: [],
      ownedStepIds: [],
    });
    expect(state.composition?.compositionId).toBeTruthy();
  });

  it('startComposition never clobbers an active draft', () => {
    const active = deployDraftReducer(
      undefined,
      seedDraft([contract('token', 'Token')])
    );
    expect(deployDraftReducer(active, startComposition(PLUGIN_ID))).toEqual(active);
  });

  it('applyComposition materializes the canonical call-plus-products shape', () => {
    const state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    const callId = `call-${compositionId}`;
    const abiContractId = `${compositionId}:abi`;

    expect(state.steps.map((step) => step.kind)).toEqual(['call', 'deploy', 'deploy']);
    expect(state.steps[0]).toMatchObject({
      id: callId,
      kind: 'call',
      target: { kind: 'address', address: PRODUCER_ADDRESS },
      signature: SIGNATURE,
      abiContractId,
    });
    // Arguments are the call step's business: they are filled on its card in
    // Steps, where the full editor (pointers, signer fill, per-chain) lives.
    expect(state.steps[0].args).toBeUndefined();
    // The frozen producer ABI source is a contract without a deploy step;
    // products are clones under composition-owned ids.
    expect(state.contracts.map((entry) => entry.id)).toEqual([
      abiContractId,
      `${compositionId}:product:jar`,
      `${compositionId}:product:releaser`,
    ]);
    expect(state.steps[1]).toMatchObject({
      kind: 'deploy',
      contractId: `${compositionId}:product:jar`,
    });
    expect(state.deployExtras[state.steps[1].id].strategy).toEqual({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      producedBy: { stepId: callId, outputIndex: 0 },
    });
    expect(state.deployExtras[state.steps[2].id].strategy).toEqual({
      kind: 'plugin',
      pluginId: PLUGIN_ID,
      producedBy: { stepId: callId, outputIndex: 1 },
    });
    expect(state.composition).toMatchObject({
      binding,
      ownedContractIds: [abiContractId, `${compositionId}:product:jar`, `${compositionId}:product:releaser`],
      ownedStepIds: [callId, `deploy-${compositionId}:product:jar`, `deploy-${compositionId}:product:releaser`],
    });
  });

  it('two products may share one artifact without colliding', () => {
    let state = setupState();
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.releaser', source: jarArtifact })
    );
    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    expect(state.contracts.map((entry) => entry.id)).toEqual([
      `${compositionId}:abi`,
      `${compositionId}:product:jar`,
      `${compositionId}:product:releaser`,
    ]);
  });

  it('applyComposition fails closed while a product is unmapped', () => {
    let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
    );
    state = deployDraftReducer(
      state,
      setCompositionValue({ key: 'address', value: PRODUCER_ADDRESS })
    );
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.jar', source: jarArtifact })
    );
    const applied = deployDraftReducer(
      state,
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    expect(applied.steps).toEqual([]);
    expect(applied.contracts).toEqual([]);
  });

  it('recomposition replaces only owned ids', () => {
    let state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    const releaserStepId = `deploy-${compositionId}:product:releaser`;
    // A declaration on the kept product must survive; the remapped product
    // is a different contract and starts over.
    state = deployDraftReducer(
      state,
      setArg({ stepId: releaserStepId, key: 'owner', value: PRODUCER_ADDRESS })
    );
    state = deployDraftReducer(
      state,
      setArg({ stepId: `deploy-${compositionId}:product:jar`, key: 'owner', value: PRODUCER_ADDRESS })
    );
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.jar', source: contract('jar2-art', 'Jar2') })
    );
    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );

    expect(state.steps).toHaveLength(3);
    expect(
      state.contracts.find((entry) => entry.id === `${compositionId}:product:jar`)
    ).toMatchObject({ contractName: 'Jar2' });
    expect(
      state.steps.find((step) => step.id === releaserStepId)?.args
    ).toMatchObject({ owner: PRODUCER_ADDRESS });
    expect(
      state.steps.find((step) => step.id === `deploy-${compositionId}:product:jar`)?.args
    ).toBeUndefined();
  });

  it('recomposition refuses to drop a product a later step references', () => {
    let state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    state = deployDraftReducer(state, addCallStep(2));
    const laterCall = state.steps[3];
    state = deployDraftReducer(
      state,
      setArg({
        stepId: laterCall.id,
        key: 'jar',
        value: { $ref: { kind: 'step', stepId: `deploy-${compositionId}:product:jar` } },
      })
    );
    const narrowed = composed([
      { key: 'releaser', artifactField: 'product.releaser', outputIndex: 0 },
    ]);
    expect(compositionMaterializationProblem(state, narrowed)).toContain(
      `deploy-${compositionId}:product:jar`
    );
    // Fail closed: the reducer mutates nothing rather than clearing the
    // user's dependency.
    const refused = deployDraftReducer(
      state,
      applyComposition({ binding, composition: narrowed })
    );
    expect(refused).toEqual(state);
  });

  it('re-apply preserves operator edits to the generated call step', () => {
    let state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const callId = `call-${state.composition!.compositionId}`;
    state = deployDraftReducer(
      state,
      setArg({ stepId: callId, key: 'salt', value: `0x${'22'.repeat(32)}` })
    );
    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const call = state.steps[0];
    expect(call.kind).toBe('call');
    expect(call.args?.salt).toBe(`0x${'22'.repeat(32)}`);
  });

  it('a recomposed function rewrites the call and drops stale args', () => {
    let state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    const callId = `call-${compositionId}`;
    state = deployDraftReducer(
      state,
      setArg({ stepId: callId, key: 'owner', value: PRODUCER_ADDRESS })
    );
    const changed: ComposedCallProducts = {
      producer: { ...TWO_PRODUCTS.producer, signature: 'deployOne(bytes32)' },
      products: [{ key: 'jar', artifactField: 'product.jar', outputIndex: 0 }],
    };
    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: changed })
    );
    const call = state.steps.find((step) => step.id === callId);
    expect(call?.kind === 'call' && call.signature).toBe('deployOne(bytes32)');
    expect(call?.args).toBeUndefined();
    expect(state.contracts.map((entry) => entry.id)).toEqual([
      `${compositionId}:abi`,
      `${compositionId}:product:jar`,
    ]);
    expect(state.steps).toHaveLength(2);
  });

  it('adding plain contracts to an empty draft abandons the composition', () => {
    let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    state = deployDraftReducer(state, addContracts([contract('token', 'Token')]));
    expect(state.composition).toBeUndefined();
    expect(state.contracts).toHaveLength(1);
  });

  // The Deployments header gates its entry points on this. Counting the shell
  // that startComposition mints as a session collapsed the composer entry /
  // "New deployment" pair into a single composer-only button as soon as the
  // user opened the composer and navigated away.
  describe('compositionInProgress', () => {
    it('is false with no composition at all', () => {
      expect(compositionInProgress(undefined)).toBe(false);
    });

    it('is false for the empty shell startComposition mints', () => {
      const state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
      expect(state.composition).toBeDefined();
      expect(compositionInProgress(state.composition)).toBe(false);
    });

    it('is false for a half-typed-then-cleared value', () => {
      let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
      state = deployDraftReducer(
        state,
        setCompositionValue({ key: 'address', value: '' })
      );
      expect(compositionInProgress(state.composition)).toBe(false);
    });

    it('is true once an artifact has been picked', () => {
      let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
      state = deployDraftReducer(
        state,
        setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
      );
      expect(compositionInProgress(state.composition)).toBe(true);
    });

    it('is true for a fully configured composition', () => {
      expect(compositionInProgress(setupState().composition)).toBe(true);
    });
  });

  it('a product cannot move above the call that creates it', () => {
    const state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const moved = deployDraftReducer(
      state,
      moveStep({ fromIndex: 1, toIndex: 0 })
    );
    expect(moved.steps.map((step) => step.id)).toEqual(
      state.steps.map((step) => step.id)
    );
  });

  it('the producer call cannot be removed while products depend on it', () => {
    const state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const callId = `call-${state.composition!.compositionId}`;
    const kept = deployDraftReducer(state, removeCallStep(callId));
    expect(kept.steps.map((step) => step.id)).toEqual(
      state.steps.map((step) => step.id)
    );
  });

  it('a product depends on the call that produces it', () => {
    const state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    const compositionId = state.composition!.compositionId;
    const callId = `call-${compositionId}`;
    const products = [
      `deploy-${compositionId}:product:jar`,
      `deploy-${compositionId}:product:releaser`,
    ];
    expect(producedStepIdsFor(state, callId)).toEqual(products);
    // The dependency closure is what warns before an exclusion and what
    // invalidates predictions: producedBy must appear in it even though the
    // product references the call through neither args nor a target.
    expect(workflowDependentsForExclusion(state, callId)).toEqual(products);
    expect(producedStepIdsFor(state, products[0])).toEqual([]);
  });

  it('recomposing to a non-payable producer clears the value it can no longer show', () => {
    const payable: ComposedCallProducts = {
      producer: { ...TWO_PRODUCTS.producer, payable: true },
      products: TWO_PRODUCTS.products,
    };
    let state = deployDraftReducer(
      setupState(),
      applyComposition({ binding, composition: payable })
    );
    const callId = `call-${state.composition!.compositionId}`;
    state = deployDraftReducer(state, setValue({ stepId: callId, value: '1' }));
    state = deployDraftReducer(
      state,
      setValuePerChain({ stepId: callId, chainId: 1, value: '2' })
    );
    expect(state.steps[0]).toMatchObject({ payable: true, value: '1' });

    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: TWO_PRODUCTS })
    );
    // Both inputs render behind `payable`, and a producer's payable flag is
    // the composer's: a retained value would be invisible, uneditable, and
    // rejected by the plan schema.
    const call = state.steps[0];
    expect(call.kind === 'call' && call.payable).toBeUndefined();
    expect(call.value).toBeUndefined();
    expect(call.valuePerChain).toBeUndefined();
  });

  it("a product keyed 'abi' cannot take over the frozen producer ABI id", () => {
    let state = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'producer', source: contract('producer-art', 'Producer') })
    );
    state = deployDraftReducer(
      state,
      setCompositionValue({ key: 'address', value: PRODUCER_ADDRESS })
    );
    state = deployDraftReducer(
      state,
      setCompositionArtifact({ key: 'product.abi', source: jarArtifact })
    );
    // 'abi' passes the server's product-key charset check, so the host must
    // not mint its own ids in a namespace a key can reach.
    const collides = composed([
      { key: 'abi', artifactField: 'product.abi', outputIndex: 0 },
    ]);
    state = deployDraftReducer(
      state,
      applyComposition({ binding, composition: collides })
    );
    const compositionId = state.composition!.compositionId;
    expect(state.contracts.map((entry) => [entry.id, entry.contractName])).toEqual([
      [`${compositionId}:abi`, 'Producer'],
      [`${compositionId}:product:abi`, 'TokenJar'],
    ]);
    expect(state.steps[0]).toMatchObject({
      kind: 'call',
      abiContractId: `${compositionId}:abi`,
    });
    expect(state.steps[1]).toMatchObject({
      kind: 'deploy',
      contractId: `${compositionId}:product:abi`,
    });

    // Re-apply must reconcile the same ids: the collision used to make the
    // keep-check miss, delete the shared id and re-add it as the product.
    const again = deployDraftReducer(
      state,
      applyComposition({ binding, composition: collides })
    );
    expect(again.contracts.map((entry) => [entry.id, entry.contractName])).toEqual(
      state.contracts.map((entry) => [entry.id, entry.contractName])
    );
    expect(again.steps.map((step) => step.id)).toEqual(
      state.steps.map((step) => step.id)
    );
    expect(again.composition!.ownedContractIds).toEqual([
      `${compositionId}:abi`,
      `${compositionId}:product:abi`,
    ]);
  });

  it('startComposition replaces an abandoned shell but never a composition holding work', () => {
    const shell = deployDraftReducer(undefined, startComposition(PLUGIN_ID));
    // A shell left behind by opening the composer and backing out must not
    // answer another plugin's entry point with this plugin's composer.
    const restarted = deployDraftReducer(shell, startComposition('other-plugin'));
    expect(restarted.composition?.pluginId).toBe('other-plugin');
    expect(restarted.composition?.compositionId).not.toBe(
      shell.composition!.compositionId
    );
    const working = deployDraftReducer(
      shell,
      setCompositionValue({ key: 'address', value: PRODUCER_ADDRESS })
    );
    expect(deployDraftReducer(working, startComposition('other-plugin'))).toEqual(
      working
    );
  });

  describe('workflow mode', () => {
    const source = {
      id: 'jar',
      repo: { url: 'https://example.com/jar.git', commit: '1'.repeat(40) },
      frameworkId: 'foundry',
      sourcePath: 'src/TokenJar.sol',
      contractName: 'TokenJar',
      artifactPath: 'out/TokenJar.sol/TokenJar.json',
    };
    const document: WorkflowDocument = {
      schemaVersion: 1,
      sources: [source, { ...source, id: 'factory-abi', contractName: 'Producer', sourcePath: 'src/Producer.sol', artifactPath: 'out/Producer.sol/Producer.json' }],
      steps: [
        { id: 'spawn', kind: 'call', target: { kind: 'address', address: PRODUCER_ADDRESS }, signature: SIGNATURE, abiContractId: 'factory-abi' },
        { id: 'deploy-jar', kind: 'deploy', contractId: 'jar', strategy: { kind: 'plugin', pluginId: PLUGIN_ID, producedBy: { stepId: 'spawn', outputIndex: 0 } } },
        { id: 'configure', kind: 'call', target: { kind: 'step', stepId: 'deploy-jar' } },
      ],
      defaultChains: [1],
      requiredPlugins: [{ id: 'foundry', version: '1' }],
      outputs: { hooks: [] },
    };
    const hydrated = () =>
      deployDraftReducer(
        undefined,
        hydrateWorkflowDraft({ repoPathOrUrl: '/repo', name: 'release', docHash: 'h', document })
      );

    it('warns that a producer call has dependents before it is excluded', () => {
      const state = hydrated();
      // Excluding a producer cascades to the products it declares, so the
      // exclusion warning — the only thing that says so — must list them.
      // The `configure` call depends on the product transitively.
      expect(workflowDependentsForExclusion(state, 'spawn')).toEqual([
        'deploy-jar',
        'configure',
      ]);
      expect(
        deployDraftReducer(state, toggleWorkflowStep('spawn'))
          .workflowIncludedStepIds?.spawn
      ).toBe(false);
    });

    it('still excludes an ordinary call step', () => {
      const state = deployDraftReducer(hydrated(), toggleWorkflowStep('configure'));
      expect(state.workflowIncludedStepIds?.configure).toBe(false);
      expect(
        deployDraftReducer(state, toggleWorkflowStep('configure'))
          .workflowIncludedStepIds?.configure
      ).toBe(true);
    });
  });
});
