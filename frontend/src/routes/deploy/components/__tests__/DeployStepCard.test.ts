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
  DraftDeployStep,
} from '../../../../store/features/deployments/types';
import { signersReducer } from '../../../../store/features/signers/signersSlice';
import DeployStepCard, { producedProductPresentation } from '../DeployStepCard';

describe('producedProductPresentation', () => {
  it('shows the constructor editor on produced products as a verification declaration', () => {
    // Declared constructor args are a produced product's only route to
    // auto-verification — the producer supplies the real values onchain.
    // Libraries stay hidden (whatever the producer linked is unknowable),
    // and a produced product sends no transaction of its own.
    expect(
      producedProductPresentation({
        kind: 'plugin',
        pluginId: 'call-products-plugin',
        producedBy: { stepId: 'call-comp-1', outputIndex: 0 },
      })
    ).toEqual({ constructorArgs: true, libraries: false, transaction: false });
  });

  it('keeps every editor for ordinary deploy strategies', () => {
    expect(producedProductPresentation(undefined)).toEqual({
      constructorArgs: true,
      libraries: true,
      transaction: true,
    });
    expect(
      producedProductPresentation({ kind: 'create2', salt: `0x${'11'.repeat(32)}` })
    ).toEqual({ constructorArgs: true, libraries: true, transaction: true });
    // A CREATE2-mode plugin strategy (no producedBy) is an ordinary
    // transaction-owning deployment.
    expect(
      producedProductPresentation({ kind: 'plugin', pluginId: 'hook' })
    ).toEqual({ constructorArgs: true, libraries: true, transaction: true });
  });
});

describe('DeployStepCard produced product declaration', () => {
  it('collapses the declaration and never seeds phantom defaults', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ getContext: () => null }) },
    });
    const step: DraftDeployStep = {
      id: 'releaser-product',
      kind: 'deploy',
      contractId: 'c2',
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
      ],
      total: 1,
      fetchedAt: null,
      loading: false,
      rpcByChain: {},
      providerRpcByChain: {},
      providerStatusesByChain: {},
      rpcCheck: { url: null, checking: false, result: null, error: null },
      providerChecks: {},
    };
    const deployDraft: DeployDraftState = {
      contracts: [],
      chains: [1],
      rpcSelection: {},
      explorerSelection: {},
      signers: {},
      steps: [step],
      deployExtras: {
        'releaser-product': {
          strategy: { kind: 'plugin', pluginId: 'call-products-plugin', producedBy: { stepId: 'call-comp-1', outputIndex: 1 } },
        },
      },
      unseenIds: [],
    };
    const store = configureStore({
      reducer: {
        chains: chainsReducer,
        deployDraft: deployDraftReducer,
        signers: signersReducer,
      },
      preloadedState: { chains, deployDraft },
    });
    // Unmounted in finally BEFORE the document stub is restored: the
    // contract-type fetch settles after the assertions and would otherwise
    // re-render Select against the real (absent) document.
    let card: ReturnType<typeof create> | undefined;
    try {
      card = create(
        createElement(Provider, {
          store,
          children: createElement(DeployStepCard, {
            step,
            // A boolean constructor input is the phantom-default canary:
            // the plain editor auto-seeds `false` for it on first render,
            // which would silently create a half-declaration.
            data: {
              abi: [
                {
                  type: 'constructor',
                  inputs: [
                    { name: 'jar', type: 'address' },
                    { name: 'paused', type: 'bool' },
                  ],
                },
              ],
            } as never,
            onMove: () => undefined,
          }),
        })
      );
      const declaration = card.root
        .findAllByType('details')
        .find((details) =>
          details.findByType('summary').children.join('').includes('Constructor arguments')
        );
      expect(declaration).toBeDefined();
      expect(
        (store.getState() as { deployDraft: DeployDraftState }).deployDraft.steps[0]
      ).not.toHaveProperty('args.paused');
    } finally {
      card?.unmount();
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
