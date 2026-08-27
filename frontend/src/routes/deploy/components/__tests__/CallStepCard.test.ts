// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { create } from 'react-test-renderer';
import { createElement } from 'react';
import {
  chainsReducer,
  type IChainsState,
} from '../../../../store/features/chains/chainsSlice';
import { deployDraftReducer } from '../../../../store/features/deployments/deployDraftSlice';
import type {
  DeployDraftState,
  DraftCallStep,
} from '../../../../store/features/deployments/types';
import { signersReducer } from '../../../../store/features/signers/signersSlice';
import CallStepCard from '../CallStepCard';

describe('CallStepCard per-chain argument overrides', () => {
  it('labels every override field with its chain name', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ getContext: () => null }) },
    });
    const step: DraftCallStep = {
      id: 'call-final',
      kind: 'call',
      target: {
        kind: 'address',
        address: '0x1111111111111111111111111111111111111111',
      },
      signature: 'configure(uint256 limit)',
    };
    const chains: IChainsState = {
      chains: [
        {
          chainId: 1,
          name: 'Ethereum',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
        {
          chainId: 8453,
          name: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
      ],
      total: 2,
      fetchedAt: null,
      loading: false,
      rpcByChain: {},
      providerRpcByChain: {},
      providerStatusesByChain: {},
      rpcCheck: {
        url: null,
        checking: false,
        result: null,
        error: null,
      },
      providerChecks: {},
    };
    const deployDraft: DeployDraftState = {
      contracts: [],
      chains: [1, 8453],
      rpcSelection: {},
      explorerSelection: {},
      signers: {},
      steps: [step],
      deployExtras: {},
      unseenIds: [],
    };
    const store = configureStore({
      reducer: {
        chains: chainsReducer,
        deployDraft: deployDraftReducer,
        signers: signersReducer,
      },
      preloadedState: {
        chains,
        deployDraft,
      },
    });
    try {
      const card = create(
        createElement(Provider, {
          store,
          children: createElement(CallStepCard, {
            step,
            artifactData: {},
            onMove: () => undefined,
          }),
        })
      );
      const argumentOverrides = card.root
        .findAllByType('details')
        .find(
          (details) =>
            details.findByType('summary').children.join('') ===
            'Per-chain override'
        );

      expect(
        argumentOverrides
          ?.findAllByProps({ className: 'font-medium' })
          .map((label) => label.children.join(''))
      ).toEqual(['Ethereum', 'Base']);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
