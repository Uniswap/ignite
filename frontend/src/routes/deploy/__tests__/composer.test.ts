// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ComposeDeploymentData, DeploymentComposerField, DeploymentTypeInfo } from '@ignite/api';
import { deployDraftInitialState } from '../../../store/features/deployments/deployDraftSlice';
import { composerEntryAction, wizardBackAction } from '../DeployWizardPage';
import {
  applyComposeResponse,
  composerInputsKey,
  composerRequiredBlocker,
  type ComposerResponseState,
} from '../useDeploymentComposer';
import { artifactFieldShowsContractTypes } from '../steps/ComposerStep';
import { composerEntryPoints } from '../../deployments/DeploymentsPage';

const composition = {
  pluginId: 'call-products-plugin',
  compositionId: 'comp-1',
  values: {},
  artifacts: {},
  ownedContractIds: [],
  ownedStepIds: [],
};

describe('composerEntryAction', () => {
  const empty = deployDraftInitialState;

  it('starts a composition only into an empty draft', () => {
    expect(composerEntryAction('call-products-plugin', empty)).toBe('start');
    expect(
      composerEntryAction('call-products-plugin', {
        ...empty,
        contracts: [{ id: 'a' } as never],
      })
    ).toBe('none');
    expect(
      composerEntryAction('call-products-plugin', { ...empty, composition })
    ).toBe('none');
    expect(
      composerEntryAction('call-products-plugin', {
        ...empty,
        workflowRef: { repoPathOrUrl: '/r', name: 'w', baseDocHash: 'h', docHash: 'h' },
      })
    ).toBe('none');
  });

  it('clears an abandoned composition when entering the plain wizard', () => {
    // Backing out of the composer before materialization must not leave "New
    // deployment" opening onto the composer station.
    expect(composerEntryAction(null, { ...empty, composition })).toBe('clear');
    expect(
      composerEntryAction(null, {
        ...empty,
        composition,
        contracts: [{ id: 'a' } as never],
      })
    ).toBe('none');
    expect(composerEntryAction(null, empty)).toBe('none');
  });

  // The wizard renders whatever composition.pluginId names, so a leftover
  // shell for plugin A under `?deploymentType=B` used to render A's composer —
  // and materialize a deployment of the wrong deployment type.
  it('restarts cleanly when an abandoned shell names another plugin', () => {
    expect(
      composerEntryAction('other-plugin', { ...empty, composition })
    ).toBe('start');
  });

  it('reports a mismatch rather than discarding composer work', () => {
    for (const holdsWork of [
      { ...composition, values: { address: '0x2179a6' } },
      { ...composition, artifacts: { producer: { id: 'a' } as never } },
      { ...composition, ownedStepIds: ['call-comp-1'] },
    ])
      expect(
        composerEntryAction('other-plugin', { ...empty, composition: holdsWork })
      ).toBe('conflict');
    // A materialized composition counts as work through its contracts.
    expect(
      composerEntryAction('other-plugin', {
        ...empty,
        composition,
        contracts: [{ id: 'a' } as never],
      })
    ).toBe('conflict');
    // …and entering the plain wizard leaves that work alone too.
    expect(
      composerEntryAction(null, {
        ...empty,
        composition: { ...composition, ownedStepIds: ['call-comp-1'] },
      })
    ).toBe('none');
  });
});

describe('wizardBackAction', () => {
  // Back used to be `disabled={step === 0}`, and the stylesheet had no
  // :disabled rule — so on the first station of both the plain and composer
  // flow it looked live, hovered, pressed, and did nothing.
  it('leaves the wizard from the first station', () => {
    expect(wizardBackAction(0)).toBe('leave');
  });

  it('steps back within the wizard from every later station', () => {
    for (const step of [1, 2, 3, 4]) {
      expect(wizardBackAction(step)).toBe('previous');
    }
  });
});

describe('applyComposeResponse', () => {
  const binding = {
    pluginId: 'call-products-plugin',
    pluginVersion: '1.0.0',
    execution: 'call-products' as const,
    descriptorHash: 'a'.repeat(64),
  };
  const response = (revision: number, blocker?: string): ComposeDeploymentData => ({
    revision,
    binding,
    fields: [{ type: 'address', key: 'address', label: `Address r${revision}` }],
    ...(blocker ? { blocker } : {}),
  });

  it('applies a response whose revision is still the latest sent', () => {
    const next = applyComposeResponse(null, 3, response(3, 'fill in the address'), 'inputs-3');
    expect(next).toMatchObject({
      revision: 3,
      blocker: 'fill in the address',
      inputsKey: 'inputs-3',
    });
    expect(next?.fields[0]).toMatchObject({ label: 'Address r3' });
  });

  it('discards an out-of-order response without touching newer state', () => {
    // Requests overlap: an older container result landing last must never
    // overwrite the fields the user is already looking at.
    const current: ComposerResponseState = {
      revision: 4,
      binding,
      fields: [{ type: 'address', key: 'address', label: 'Address r4' }],
      inputsKey: 'inputs-4',
    };
    expect(applyComposeResponse(current, 4, response(3), 'inputs-3')).toBe(current);
    expect(applyComposeResponse(null, 4, response(3), 'inputs-3')).toBeNull();
  });

  it('drops a stale blocker when a newer clean response arrives', () => {
    const blocked = applyComposeResponse(null, 1, response(1, 'incomplete'), 'inputs-1');
    const clean = applyComposeResponse(blocked, 2, response(2), 'inputs-2');
    expect(clean?.blocker).toBeUndefined();
  });
});

describe('composerInputsKey', () => {
  it('changes when values or artifact selections change', () => {
    // Address typing never recomposes, so this key is what tells the wizard
    // a served blocker no longer describes the inputs on screen.
    const base = { values: { address: '0x12' }, artifacts: {} };
    expect(composerInputsKey(base)).toBe(composerInputsKey({ ...base }));
    expect(composerInputsKey(base)).not.toBe(
      composerInputsKey({ ...base, values: { address: '0x13' } })
    );
    expect(composerInputsKey(base)).not.toBe(
      composerInputsKey({ ...base, artifacts: { producer: { id: 'a' } } as never })
    );
  });
});

describe('composerRequiredBlocker', () => {
  const fields: DeploymentComposerField[] = [
    { type: 'artifact', key: 'producer', label: 'Producer contract', required: true, origins: ['repo'] },
    { type: 'address', key: 'address', label: 'Producer address', required: true },
    { type: 'select', key: 'function', label: 'Function', required: true, options: [{ value: 'deploy(bytes32)', label: 'deploy' }] },
  ];

  it('walks the operator through the required fields in order', () => {
    expect(composerRequiredBlocker(fields, {}, {})).toBe('Producer contract is required');
    expect(
      composerRequiredBlocker(fields, {}, { producer: { id: 'a' } })
    ).toBe('Producer address is required');
    expect(
      composerRequiredBlocker(fields, { address: `0x${'21'.repeat(20)}` }, { producer: { id: 'a' } })
    ).toBe('Function is required');
    expect(
      composerRequiredBlocker(
        fields,
        { address: `0x${'21'.repeat(20)}`, function: 'deploy(bytes32)' },
        { producer: { id: 'a' } }
      )
    ).toBeUndefined();
  });

  it('rejects a malformed address even on an optional field', () => {
    expect(
      composerRequiredBlocker(
        [{ type: 'address', key: 'address', label: 'Producer address' }],
        { address: '0x12' },
        {}
      )
    ).toBe('Producer address must be a 0x address');
  });

  it('lets optional fields stay empty', () => {
    expect(
      composerRequiredBlocker(
        [{ type: 'select', key: 'mode', label: 'Mode', options: [{ value: 'a', label: 'A' }] }],
        {},
        {}
      )
    ).toBeUndefined();
  });
});

describe('artifactFieldShowsContractTypes', () => {
  it('hides contract-type sources when the field restricts origins to repo', () => {
    expect(
      artifactFieldShowsContractTypes({ type: 'artifact', key: 'producer', label: 'Producer', origins: ['repo'] })
    ).toBe(false);
  });

  it('offers contract-type sources when declared or unrestricted', () => {
    expect(
      artifactFieldShowsContractTypes({ type: 'artifact', key: 'producer', label: 'Producer', origins: ['repo', 'contract-type'] })
    ).toBe(true);
    expect(
      artifactFieldShowsContractTypes({ type: 'artifact', key: 'producer', label: 'Producer' })
    ).toBe(true);
  });
});

describe('composerEntryPoints', () => {
  it('derives one entry per compose-supporting descriptor, with no hardcoded identity', () => {
    const types: DeploymentTypeInfo[] = [
      { pluginId: 'call-products-plugin', pluginVersion: '1.0.0', label: 'Deploy via producer', description: '', execution: 'call-products', params: [], validateSupported: false, composeSupported: true },
      { pluginId: 'hook', pluginVersion: '2.0.0', label: 'Hook miner', description: '', execution: 'create2', params: [], validateSupported: true, composeSupported: false },
    ];
    expect(composerEntryPoints(types)).toEqual([
      {
        pluginId: 'call-products-plugin',
        label: 'Deploy via producer',
        to: '/deploy?deploymentType=call-products-plugin',
      },
    ]);
  });
});
