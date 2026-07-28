// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ExplorerEntry } from '@ignite/api';
import { explorerBlocker } from '../DeployWizardPage';
import {
  deployDraftReducer,
  setExplorerSelection,
} from '../../../store/features/deployments/deployDraftSlice';
import {
  explorerEntriesInvalidated,
  explorerReceived,
  explorerSelectionReceived,
  explorersFetched,
  explorersReducer,
} from '../../../store/features/explorers/explorersSlice';
import { pluginsApi } from '../../../store/features/plugins/pluginsSlice';

const entry: ExplorerEntry = {
  id: 'scan',
  chainId: 1,
  url: 'https://etherscan.io',
  source: 'manual',
  label: 'Etherscan',
};

describe('explorer wizard behavior', () => {
  it('only blocks selected explorer entries that need mapping or config', () => {
    const name = () => 'Ethereum';
    expect(explorerBlocker([1], {}, { '1': [entry] }, name)).toBeUndefined();
    expect(
      explorerBlocker([1], { '1': ['scan'] }, { '1': [entry] }, name)
    ).toBe('Ethereum: Etherscan needs a verifier type');
    expect(
      explorerBlocker(
        [1],
        { '1': ['scan'] },
        { '1': [{ ...entry, verifierPluginId: 'etherscan', needsConfig: true }] },
        name
      )
    ).toBe('Ethereum: Etherscan needs configuration');
  });

  it('keeps selection in the deployment draft and stores confirmed mappings', () => {
    const draft = deployDraftReducer(
      undefined,
      setExplorerSelection({ '1': ['scan'] })
    );
    expect(draft.explorerSelection).toEqual({ '1': ['scan'] });
    let explorers = explorersReducer(undefined, explorerReceived(entry));
    explorers = explorersReducer(
      explorers,
      explorerReceived({ ...entry, verifierPluginId: 'etherscan' })
    );
    expect(explorers.byChain['1']?.[0].verifierPluginId).toBe('etherscan');
  });

  it('merges per-chain selection responses without clobbering another chain', () => {
    let explorers = explorersReducer(
      undefined,
      explorerSelectionReceived({ '1': ['scan'] })
    );
    explorers = explorersReducer(
      explorers,
      explorerSelectionReceived({ '8453': ['base-scan'] })
    );
    expect(explorers.selection).toEqual({
      '1': ['scan'],
      '8453': ['base-scan'],
    });
  });

  // A verifier reports needs-config by returning no explorers, and that state
  // is cached per plugin. Saving the API key clears the cache server-side, so
  // the stale entry has to be dropped here too or the step keeps blocking with
  // "needs configuration" until the process restarts.
  it('drops cached entries when a plugin configuration changes', () => {
    const unconfigured = { ...entry, verifierPluginId: 'etherscan', needsConfig: true };
    let explorers = explorersReducer(
      undefined,
      explorersFetched({ chainId: 1, data: { entries: [unconfigured], selection: ['scan'] } })
    );
    expect(
      explorerBlocker([1], { '1': ['scan'] }, explorers.byChain, () => 'Ethereum')
    ).toBe('Ethereum: Etherscan needs configuration');

    explorers = explorersReducer(explorers, explorerEntriesInvalidated());

    // undefined is the never-requested sentinel the fetch guards key off, so
    // the entries get requested again with the freshly configured state.
    expect(explorers.byChain['1']).toBeUndefined();
  });

  it('invalidates explorer entries when a plugin secret is saved', () => {
    const action = pluginsApi.setSecret('etherscan', {
      key: 'apiKey',
      value: 'secret',
    }) as unknown as {
      payload: { apiAction: { payload: { onSuccess: (data: unknown) => unknown } } };
    };

    const produced = action.payload.apiAction.payload.onSuccess({
      fields: [],
      values: {},
      secretsPresent: ['apiKey'],
      grantedSecrets: ['apiKey'],
    });

    expect(
      (Array.isArray(produced) ? produced : [produced]).map(
        (item) => (item as { type: string }).type
      )
    ).toContain(explorerEntriesInvalidated.type);
  });
});
