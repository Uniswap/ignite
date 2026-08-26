// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DeployDraftState } from '../../../store/features/deployments/types';
import {
  callArgumentPointerSteps,
  callTargetPointerSteps,
  dependentPlanStepIds,
  partitionDeterministicChains,
  eligiblePointerSteps,
} from '../pointerEligibility';

const draft = (): DeployDraftState => ({
  contracts: ['A', 'B', 'C'].map((id) => ({
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `${id}.json`,
    contractName: id,
    sourcePath: `${id}.sol`,
  })),
  chains: [],
  rpcSelection: {},
  explorerSelection: {},
  signers: {},
  unseenIds: [],
  steps: ['A', 'B', 'C'].map((id) => ({
    id: `deploy-${id}`,
    kind: 'deploy' as const,
    contractId: id,
  })),
  deployExtras: {},
});

describe('eligiblePointerSteps', () => {
  it('allows only earlier plain-create deploys from a plain create step', () => {
    const state = draft();
    expect(eligiblePointerSteps(state, 'deploy-B')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-C',
        label: 'C',
        disabledReason:
          'Later plain-create step — address unknown at prediction time',
      },
    ]);
  });

  it('allows deterministic targets anywhere but prevents prediction cycles', () => {
    const state = draft();
    state.deployExtras['deploy-A'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[0].args = {
      target: { $ref: { kind: 'step', stepId: 'deploy-B' } },
    };
    const options = eligiblePointerSteps(state, 'deploy-B');
    expect(
      options.find((option) => option.stepId === 'deploy-A')?.disabledReason
    ).toBe('Would create a prediction cycle');
  });

  it('allows an earlier plain-create target from a deterministic step and blocks a later one', () => {
    const state = draft();
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };

    expect(eligiblePointerSteps(state, 'deploy-B')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-C',
        label: 'C',
        disabledReason: 'Later plain-create step — lands after this deployment',
      },
    ]);
  });

  it('blocks a forward deterministic target that is dynamic on a selected chain', () => {
    const state = draft();
    state.chains = [1];
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[2].args = {
      box: { $ref: { kind: 'step', stepId: 'deploy-A' } },
    };

    expect(
      eligiblePointerSteps(state, 'deploy-B').find(
        (option) => option.stepId === 'deploy-C'
      )
    ).toEqual({
      stepId: 'deploy-C',
      label: 'C',
      disabledReason:
        'Later dynamic deterministic step — lands after this deployment',
    });
  });

  it('partitions dynamic deterministic steps per chain after args and library merges', () => {
    const state = draft();
    state.chains = [1, 2];
    state.deployExtras['deploy-B'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[1].argsPerChain = {
      '1': { box: { $ref: { kind: 'step', stepId: 'deploy-A' } } },
    };
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
      librariesPerChain: {
        '2': { 'src/Box.sol:Box': { kind: 'step', stepId: 'deploy-A' } },
      },
    };

    expect(partitionDeterministicChains(state, 'deploy-B')).toEqual({
      staticChains: [2],
      dynamicChains: [1],
    });
    expect(partitionDeterministicChains(state, 'deploy-C')).toEqual({
      staticChains: [1],
      dynamicChains: [2],
    });
  });

  it('finds plan dependents through arguments, call targets, and library bindings', () => {
    expect(
      dependentPlanStepIds(
        [
          { id: 'source', kind: 'deploy', contractId: 'A' },
          {
            id: 'args',
            kind: 'deploy',
            contractId: 'B',
            args: { owner: { $ref: { kind: 'step', stepId: 'source' } } },
          },
          {
            id: 'target',
            kind: 'call',
            target: { kind: 'step', stepId: 'source' },
          },
          {
            id: 'library',
            kind: 'deploy',
            contractId: 'C',
            libraries: { Lib: { kind: 'step', stepId: 'source' } },
          },
        ],
        'source'
      )
    ).toEqual(['args', 'target', 'library']);
  });

  it('explains why later call targets are unavailable but permits static deterministic argument pointers', () => {
    const state = draft();
    state.steps.splice(1, 0, { id: 'call', kind: 'call', target: null });
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'create2', salt: `0x${'1'.repeat(64)}` },
    };

    expect(callTargetPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-B',
        label: 'B',
        disabledReason: 'Later plain-create step — lands after this call',
      },
      {
        stepId: 'deploy-C',
        label: 'C',
        disabledReason: 'Later deterministic step — lands after this call',
      },
    ]);
    expect(callArgumentPointerSteps(state, 'call')).toEqual([
      { stepId: 'deploy-A', label: 'A' },
      {
        stepId: 'deploy-B',
        label: 'B',
        disabledReason:
          'Later plain-create step — address unknown at prediction time',
      },
      { stepId: 'deploy-C', label: 'C' },
    ]);
  });

  it('blocks a plain-create or call from pointing forward to a dynamic deployment', () => {
    const state = draft();
    state.chains = [1];
    state.deployExtras['deploy-C'] = {
      strategy: { kind: 'plugin', pluginId: 'deterministic' },
    };
    state.steps[2].args = {
      box: { $ref: { kind: 'step', stepId: 'deploy-A' } },
    };
    expect(eligiblePointerSteps(state, 'deploy-B').find((option) => option.stepId === 'deploy-C')).toMatchObject({
      disabledReason:
        'Later dynamic deterministic step — lands after this deployment',
    });

    state.steps.splice(1, 0, { id: 'call', kind: 'call', target: null });
    expect(callTargetPointerSteps(state, 'call').find((option) => option.stepId === 'deploy-C')).toMatchObject({
      disabledReason: 'Later dynamic deterministic step — lands after this call',
    });
    expect(callArgumentPointerSteps(state, 'call').find((option) => option.stepId === 'deploy-C')).toMatchObject({
      disabledReason: 'Later dynamic deterministic step — lands after this call',
    });
  });
});

// A produced product's address exists only once its producer call has run, so
// this mirror must classify it dynamic exactly as core does — otherwise the
// picker offers references the run can never resolve.
describe('produced products in the pointer picker', () => {
  // [call-factory, deploy-A (product of it), deploy-B (create2), deploy-C]
  const producedDraft = (): DeployDraftState => {
    const state = draft();
    state.chains = [1];
    state.steps = [
      { id: 'call-factory', kind: 'call', target: null, signature: 'deploy(address)' },
      ...state.steps,
    ];
    state.deployExtras['deploy-A'] = {
      strategy: {
        kind: 'plugin',
        pluginId: 'factory',
        producedBy: { stepId: 'call-factory', outputIndex: 0 },
      },
    };
    state.deployExtras['deploy-B'] = { strategy: { kind: 'create2' } };
    return state;
  };

  it('offers a product to a later create2 step and marks that step dynamic', () => {
    const state = producedDraft();
    expect(
      eligiblePointerSteps(state, 'deploy-B').find((option) => option.stepId === 'deploy-A')
    ).toEqual({ stepId: 'deploy-A', label: 'A' });
    state.steps[2].args = { jar: { $ref: { kind: 'step', stepId: 'deploy-A' } } };
    // Nothing is mined ahead of the run for this step on this chain.
    expect(partitionDeterministicChains(state, 'deploy-B')).toEqual({
      staticChains: [],
      dynamicChains: [1],
    });
  });

  it('disables a product that a step would reference before the producer runs', () => {
    const state = producedDraft();
    // Move the create2 consumer ahead of the product it points at.
    state.steps = [state.steps[0], state.steps[2], state.steps[1], state.steps[3]];
    expect(
      eligiblePointerSteps(state, 'deploy-B').find((option) => option.stepId === 'deploy-A')
    ).toEqual({
      stepId: 'deploy-A',
      label: 'A',
      disabledReason: 'Later dynamic deterministic step — lands after this deployment',
    });
  });

  it('disables a product for a call argument that is encoded before the producer', () => {
    const state = producedDraft();
    state.steps = [
      { id: 'register', kind: 'call', target: null, signature: 'register(address)' },
      ...state.steps,
    ];
    expect(
      callArgumentPointerSteps(state, 'register').find((option) => option.stepId === 'deploy-A')
    ).toMatchObject({
      disabledReason: 'Later dynamic deterministic step — lands after this call',
    });
    expect(
      callTargetPointerSteps(state, 'register').find((option) => option.stepId === 'deploy-A')
    ).toMatchObject({
      disabledReason: 'Later dynamic deterministic step — lands after this call',
    });
  });

  // A product's args are verification declarations the producer supplies
  // onchain, so — as in core's collectRefs — they are no prediction edge and
  // this pair is not a cycle.
  it('does not read a product\'s declared args as a prediction cycle', () => {
    const state = producedDraft();
    state.steps[1].args = { peer: { $ref: { kind: 'step', stepId: 'deploy-B' } } };
    state.steps[2].args = { jar: { $ref: { kind: 'step', stepId: 'deploy-A' } } };
    expect(
      eligiblePointerSteps(state, 'deploy-B').find((option) => option.stepId === 'deploy-A')
    ).toEqual({ stepId: 'deploy-A', label: 'A' });
  });
});
