// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ChainInfo } from '@ignite/api';
import {
  explorerLookupOptions,
  explorerLookupUrl,
} from '../ExplorerLookup';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function chain(overrides: Partial<ChainInfo>): ChainInfo {
  return {
    chainId: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [],
    source: 'chainlist',
    ...overrides,
  } as ChainInfo;
}

const MAINNET = chain({
  chainId: 1,
  name: 'Ethereum',
  explorers: [
    { name: 'Etherscan', url: 'https://etherscan.io/', standard: 'EIP3091' },
    {
      name: 'Blockscout',
      url: 'https://eth.blockscout.com',
      standard: 'EIP3091',
    },
    { name: 'Otterscan', url: 'https://otter.example' },
  ],
});
const BASE = chain({
  chainId: 8453,
  name: 'Base',
  explorers: [
    { name: 'Basescan', url: 'https://basescan.org', standard: 'EIP3091' },
  ],
});

describe('explorerLookupOptions', () => {
  it('builds one option per chain and EIP3091 explorer', () => {
    const options = explorerLookupOptions([MAINNET, BASE], [1, 8453]);
    expect(options.map((option) => option.label)).toEqual([
      'Ethereum - Etherscan',
      'Ethereum - Blockscout',
      'Base - Basescan',
    ]);
  });

  it('only includes selected chains', () => {
    const options = explorerLookupOptions([MAINNET, BASE], [8453]);
    expect(options.map((option) => option.label)).toEqual([
      'Base - Basescan',
    ]);
  });

  it('skips explorers without the EIP3091 standard', () => {
    const options = explorerLookupOptions([MAINNET], [1]);
    expect(
      options.some((option) => option.label.includes('Otterscan'))
    ).toBe(false);
  });

  it('dedupes explorers sharing a URL and skips non-http URLs', () => {
    const noisy = chain({
      chainId: 10,
      name: 'Optimism',
      explorers: [
        { name: 'A', url: 'https://scan.example//', standard: 'EIP3091' },
        { name: 'B', url: 'https://scan.example', standard: 'EIP3091' },
        { name: 'C', url: 'ftp://scan.example', standard: 'EIP3091' },
      ],
    });
    const options = explorerLookupOptions([noisy], [10]);
    expect(options).toHaveLength(1);
    expect(options[0].addressUrlBase).toBe('https://scan.example');
  });

  it('handles chains without explorers and unknown chain ids', () => {
    expect(
      explorerLookupOptions([chain({ chainId: 7, explorers: undefined })], [7, 99])
    ).toEqual([]);
  });
});

describe('explorerLookupUrl', () => {
  it('builds an EIP3091 address URL', () => {
    const [option] = explorerLookupOptions([BASE], [8453]);
    expect(explorerLookupUrl(option, ADDRESS)).toBe(
      `https://basescan.org/address/${ADDRESS}`
    );
  });
});
