// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chainsReducer,
  fetchChainsSucceeded,
} from '../../../../store/features/chains/chainsSlice';
import ChainOverrideCard from '../ChainOverrideCard';

const base = {
  chainId: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: [],
  source: 'chainlist' as const,
};

describe('ChainOverrideCard', () => {
  const store = configureStore({ reducer: { chains: chainsReducer } });
  store.dispatch(
    fetchChainsSucceeded({ chains: [base], total: 1, fetchedAt: null })
  );
  const render = (chainId: number) =>
    renderToStaticMarkup(
      <Provider store={store}>
        <ChainOverrideCard chainId={chainId}>
          <input aria-label="override" />
        </ChainOverrideCard>
      </Provider>
    );

  it('labels the override with the chain name and id', () => {
    const html = render(8453);
    expect(html).toContain('Base');
    expect(html).toContain('>8453<');
    expect(html).toContain('aria-label="override"');
  });

  it('falls back to the chain id when metadata has not loaded', () => {
    expect(render(84532)).toContain('Chain 84532');
  });
});
