import { describe, it, expect, vi } from 'vitest';
import {
  ChainRegistry,
  CHAINLIST_CACHE_VERSION,
  mergeCustomChain,
} from '../../chains/ChainRegistry.js';
import {
  applyBuiltinOverrides,
  BUILTIN_CHAIN_OVERRIDES,
  type ChainOverride,
} from '../../chains/chainOverrides.js';

// Two-entry chainlist sample mirroring chainid.network/chains.json shape,
// including a templated RPC URL that must be filtered out.
const CHAINLIST_SAMPLE = [
  {
    name: 'Ethereum Mainnet',
    chain: 'ETH',
    rpc: [
      'https://eth.llamarpc.com',
      'https://mainnet.infura.io/v3/${INFURA_API_KEY}',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://ethereum.org',
    shortName: 'eth',
    icon: 'ethereum',
    chainId: 1,
    networkId: 1,
    explorers: [
      { name: 'etherscan', url: 'https://etherscan.io', standard: 'EIP3091' },
    ],
  },
  {
    name: 'OP Mainnet',
    chain: 'ETH',
    rpc: ['https://mainnet.optimism.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    shortName: 'oeth',
    chainId: 10,
  },
  { name: 'Broken entry with no chainId', rpc: [] },
  { name: 'Bad float', chainId: 1.5, rpc: [] },
  { name: 'Bad zero', chainId: 0, rpc: [] },
  {
    name: 'Bad Decimals',
    chain: 'BAD',
    rpc: [],
    nativeCurrency: { name: 'X', symbol: 'X', decimals: -3 },
    shortName: 'bad',
    icon: '../evil', // path chars → icon slug must be rejected
    chainId: 42,
  },
  {
    // Second zero-TVL chain: exercises the alphabetical tiebreak
    // ('Aardvark…' < 'Bad Decimals'). Has an icon slug but no DefiLlama
    // entry → iconUrl must derive from the slug.
    name: 'Aardvark Testnet',
    chain: 'AARD',
    rpc: [],
    nativeCurrency: { name: 'Aard', symbol: 'AARD', decimals: 18 },
    shortName: 'aard',
    icon: 'aardvark',
    chainId: 7777,
  },
];

// DefiLlama /chains sample: string chainId must coerce, entries without a
// chainId (non-EVM) or with neither a positive numeric tvl nor a usable
// name must be ignored.
const LLAMA_SAMPLE = [
  { chainId: 1, name: 'Ethereum', tvl: 80e9 },
  { chainId: 10, name: 'OP', tvl: 5e8 },
  { chainId: '42161', name: 'Arb', tvl: 2e9 },
  { name: 'Solana', tvl: 1e10 },
  { chainId: 2, tvl: null },
];

// Registries under test carry no shipped chain corrections unless a test
// opts in, so the dataset fixtures above are exactly what the registry sees.
function makeDeps(overrides?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  files?: Map<string, unknown>;
  chainOverrides?: Readonly<Record<number, ChainOverride>>;
}) {
  const files = overrides?.files ?? new Map<string, unknown>();
  const fetchImpl =
    overrides?.fetchImpl ??
    ((async (url: string | URL) => ({
      ok: true,
      json: async () =>
        String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
    })) as unknown as typeof fetch);
  return {
    files,
    deps: {
      fileSystem: {
        getChainlistCachePath: () => '/chains/chainlist-cache.json',
        getUserChainsPath: () => '/chains/user-chains.json',
        fileExists: async (p: string) => files.has(p),
        readJsonFile: async <T,>(p: string): Promise<T> => {
          if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
          return files.get(p) as T;
        },
        writeJsonFile: async <T,>(p: string, data: T) => {
          files.set(p, JSON.parse(JSON.stringify(data)));
        },
      },
      fetchImpl,
      now: overrides?.now ?? (() => 1_800_000_000_000),
      overrides: overrides?.chainOverrides ?? {},
    },
  };
}

describe('ChainRegistry', () => {
  it('fetches, parses and caches the chainlist on first list', async () => {
    const { deps, files } = makeDeps();
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    // Broken entry (no chainId), non-integer chainId and zero chainId are
    // all dropped; templated RPC URL filtered.
    expect(data.total).toBe(4);
    expect(data.chains.some((c) => c.chainId === 1.5)).toBe(false);
    expect(data.chains.some((c) => c.chainId === 0)).toBe(false);
    const eth = data.chains.find((c) => c.chainId === 1)!;
    expect(eth.source).toBe('chainlist');
    expect(eth.rpc).toEqual(['https://eth.llamarpc.com']);
    expect(eth.explorers?.[0]?.url).toBe('https://etherscan.io');
    // DefiLlama name ('Ethereum') is the primary icon key.
    expect(eth.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg'
    );
    // No chainid.network icon slug, but a DefiLlama entry ('OP') → the icon
    // derives from the llama name.
    const op = data.chains.find((c) => c.chainId === 10)!;
    expect(op.iconUrl).toBe('https://icons.llamao.fi/icons/chains/rsz_op.jpg');
    // Icon slug but no DefiLlama entry → the icon derives from the slug.
    const aard = data.chains.find((c) => c.chainId === 7777)!;
    expect(aard.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_aardvark.jpg'
    );
    // Invalid (negative) decimals from the untrusted dataset default to 18
    // rather than being persisted as-is.
    const bad = data.chains.find((c) => c.chainId === 42)!;
    expect(bad.nativeCurrency.decimals).toBe(18);
    // Icon slugs with path characters ('../evil') are rejected outright, and
    // chain 42 has no DefiLlama entry either → no iconUrl at all (frontend
    // letter fallback).
    expect(bad.iconUrl).toBeUndefined();
    expect(files.has('/chains/chainlist-cache.json')).toBe(true);
    expect(data.fetchedAt).toBeTruthy();
  });

  it('serves the cache without refetching while fresh', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => ({
      ok: true,
      json: async () =>
        String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
    }));
    const { deps } = makeDeps({ fetchImpl: fetchSpy as unknown as typeof fetch });
    const registry = new ChainRegistry(deps);
    await registry.listChains();
    await registry.listChains();
    // One refresh = one chainlist fetch + one DefiLlama TVL fetch; the
    // second listChains is served entirely from cache.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes('chainid.network'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('api.llama.fi'))).toHaveLength(1);
  });

  it('serves stale cache when a refresh attempt fails', async () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      fetchedAt: new Date(0).toISOString(), // ancient → stale
      chains: [
        {
          chainId: 1,
          name: 'Ethereum Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
      ],
    });
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: boom, files });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.chains).toHaveLength(1);
    expect(data.chains[0].name).toBe('Ethereum Mainnet');
  });

  it('refreshChainlist throws coded error when fetch fails with no cache', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: boom });
    const registry = new ChainRegistry(deps);
    await expect(registry.refreshChainlist(true)).rejects.toMatchObject({
      code: 'CHAINLIST_REFRESH_ERROR',
    });
  });

  // A custom record is the user's correction and wins over the registry
  // entry sharing its chainId: same name → it augments that chain, different
  // name → it describes another network and shadows the entry entirely.
  it('a same-named custom record augments the chainlist entry', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 1,
      name: 'Ethereum Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'WETH', decimals: 18 },
      explorers: [{ name: 'blockscout', url: 'https://eth.blockscout.com' }],
      // One extra endpoint plus an exact duplicate of a chainlist suggestion:
      // the union must lead with the user's URLs and dedupe the repeat.
      rpc: ['https://rpc.myfork.local', 'https://eth.llamarpc.com'],
    });

    const chain = await registry.getChain(1);
    expect(chain?.nativeCurrency.symbol).toBe('WETH');
    expect(chain?.explorers).toEqual([
      { name: 'blockscout', url: 'https://eth.blockscout.com' },
    ]);
    expect(chain?.rpc).toEqual([
      'https://rpc.myfork.local',
      'https://eth.llamarpc.com',
    ]);
    // Fields the record leaves unset carry over from the entry.
    expect(chain?.shortName).toBe('eth');
    expect(chain?.infoURL).toBe('https://ethereum.org');
    expect(chain?.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg'
    );
    // 'custom' survives purely as the management marker.
    expect(chain?.source).toBe('custom');

    // The merged entry appears exactly once, in the custom-first position,
    // and listChains returns the same merged shape getChain does.
    const list = await registry.listChains();
    expect(list.chains.filter((c) => c.chainId === 1)).toHaveLength(1);
    expect(list.chains[0]).toEqual(chain);
  });

  it('a renamed custom record shadows the chainlist entry entirely', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 1,
      name: 'My Fork',
      nativeCurrency: { name: 'Fork Ether', symbol: 'fETH', decimals: 18 },
      rpc: ['https://rpc.myfork.local'],
    });
    // Nothing from the entry survives: its RPCs, explorers and icon would
    // all point at the wrong network.
    expect(await registry.getChain(1)).toEqual({
      chainId: 1,
      name: 'My Fork',
      shortName: undefined,
      nativeCurrency: { name: 'Fork Ether', symbol: 'fETH', decimals: 18 },
      rpc: ['https://rpc.myfork.local'],
      explorers: undefined,
      infoURL: undefined,
      source: 'custom',
    });
    const list = await registry.listChains();
    expect(list.chains.filter((c) => c.chainId === 1)).toHaveLength(1);
  });

  it('custom chains without a chainlist counterpart are returned as-is', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: ['https://rpc.stealth.local'],
    });
    const chain = await registry.getChain(999999);
    expect(chain).toEqual({
      chainId: 999999,
      name: 'Stealth Testnet',
      shortName: undefined,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: ['https://rpc.stealth.local'],
      explorers: undefined,
      infoURL: undefined,
      source: 'custom',
    });
  });

  describe('mergeCustomChain', () => {
    const entry = {
      chainId: 1,
      name: 'Ethereum Mainnet',
      shortName: 'eth',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: ['https://eth.llamarpc.com', 'https://rpc.myfork.local'],
      explorers: [{ name: 'etherscan', url: 'https://etherscan.io' }],
      infoURL: 'https://ethereum.org',
      iconUrl: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
      source: 'chainlist' as const,
    };
    const custom = {
      chainId: 1,
      name: 'Ethereum Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'WETH', decimals: 18 },
      rpc: ['https://rpc.myfork.local'],
      source: 'custom' as const,
    };

    it('returns the custom chain untouched without a registry entry', () => {
      expect(mergeCustomChain(custom, undefined)).toBe(custom);
    });

    it('lets the custom record win and fills its gaps from the entry', () => {
      expect(mergeCustomChain(custom, entry)).toEqual({
        ...entry,
        nativeCurrency: custom.nativeCurrency,
        // User URLs first, then the unseen suggestions, deduped.
        rpc: ['https://rpc.myfork.local', 'https://eth.llamarpc.com'],
        source: 'custom',
      });
    });

    it('returns the custom chain untouched when it renames the entry', () => {
      const renamed = { ...custom, name: 'My Fork' };
      expect(mergeCustomChain(renamed, entry)).toBe(renamed);
    });
  });

  it('lists custom chains first and filters by q on name, shortName and chainId', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const all = await registry.listChains();
    expect(all.chains[0].chainId).toBe(999999);

    expect(
      (await registry.listChains({ q: 'stealth' })).chains.map((c) => c.chainId)
    ).toEqual([999999]);
    expect(
      (await registry.listChains({ q: 'oeth' })).chains.map((c) => c.chainId)
    ).toEqual([10]);
    expect(
      (await registry.listChains({ q: '10' })).chains.map((c) => c.chainId)
    ).toEqual([10]);
  });

  it('applies limit after filtering and reports total', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    const limited = await registry.listChains({ limit: 1 });
    expect(limited.chains).toHaveLength(1);
    expect(limited.total).toBe(4);
  });

  it('deleteCustomChain removes custom entries and rejects non-custom ids', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    await registry.deleteCustomChain(999999);
    expect(await registry.getChain(999999)).toBeUndefined();

    await expect(registry.deleteCustomChain(1)).rejects.toMatchObject({
      code: 'CHAIN_NOT_CUSTOM',
    });
    await expect(registry.deleteCustomChain(123456789)).rejects.toMatchObject({
      code: 'CHAIN_NOT_FOUND',
    });
  });

  it('tolerates a corrupt user-chains file by treating it as empty', async () => {
    const files = new Map<string, unknown>();
    const { deps } = makeDeps({ files });
    // Simulate corruption: fileExists true but readJsonFile throws.
    files.set('/chains/user-chains.json', undefined);
    deps.fileSystem.readJsonFile = async <T,>(p: string): Promise<T> => {
      if (p === '/chains/user-chains.json') throw new Error('corrupt');
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as T;
    };
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.chains.some((c) => c.source === 'custom')).toBe(false);
  });

  it('deleteCustomChain correctly identifies chainlist ids on cold cache', async () => {
    // Fresh registry with empty files, no prior warmup calls
    const { deps } = makeDeps({ files: new Map() });
    const registry = new ChainRegistry(deps);
    // First call is deleteCustomChain(1), which must fetch chainlist to distinguish
    // between "id exists on chainlist" vs "id unknown"
    await expect(registry.deleteCustomChain(1)).rejects.toMatchObject({
      code: 'CHAIN_NOT_CUSTOM',
    });
  });

  it('orders chainlist entries by TVL descending, zero-TVL last with alpha tiebreak', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    // Ethereum ($80B) > OP ($0.5B) > zero-TVL chains alphabetically
    // (Aardvark Testnet before Bad Decimals).
    expect(data.chains.map((c) => c.chainId)).toEqual([1, 10, 7777, 42]);
    // TVL is cache-internal ordering data and must never appear on the
    // ChainInfo entries themselves.
    expect(data.chains.some((c) => 'tvl' in c)).toBe(false);
  });

  it('coerces string chainIds from DefiLlama and ignores entries missing chainId or data', async () => {
    const { deps, files } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.listChains();
    const cache = files.get('/chains/chainlist-cache.json') as {
      version?: number;
      llama?: Record<string, { tvl?: number; name?: string }>;
    };
    // '42161' (string) coerced; Solana (no chainId) and chainId 2 (null tvl,
    // no name) dropped. Both tvl and name are captured per chainId.
    expect(cache.llama).toEqual({
      '1': { tvl: 80e9, name: 'Ethereum' },
      '10': { tvl: 5e8, name: 'OP' },
      '42161': { tvl: 2e9, name: 'Arb' },
    });
    // Refreshes stamp the current schema version.
    expect(cache.version).toBe(CHAINLIST_CACHE_VERSION);
  });

  it('still refreshes chains when the DefiLlama fetch fails, ordering by name', async () => {
    const llamaDown = (async (url: string | URL) => {
      if (String(url).includes('api.llama.fi')) throw new Error('llama down');
      return { ok: true, json: async () => CHAINLIST_SAMPLE };
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: llamaDown });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.total).toBe(4);
    // No TVL data at all → pure name-alpha order.
    expect(data.chains.map((c) => c.chainId)).toEqual([7777, 42, 1, 10]);
  });

  it('keeps the previous llama data when a refresh succeeds but the DefiLlama fetch fails', async () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      version: CHAINLIST_CACHE_VERSION,
      fetchedAt: new Date(0).toISOString(), // ancient → stale, forces refresh
      chains: [],
      llama: { '10': { tvl: 123 } }, // stale llama data beats none
    });
    const llamaDown = (async (url: string | URL) => {
      if (String(url).includes('api.llama.fi')) throw new Error('llama down');
      return { ok: true, json: async () => CHAINLIST_SAMPLE };
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: llamaDown, files });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.total).toBe(4);
    // Chain 10 leads on the preserved stale TVL; the rest fall back to
    // name-alpha.
    expect(data.chains.map((c) => c.chainId)).toEqual([10, 7777, 42, 1]);
    const cache = files.get('/chains/chainlist-cache.json') as {
      llama?: Record<string, { tvl?: number; name?: string }>;
    };
    expect(cache.llama).toEqual({ '10': { tvl: 123 } });
  });

  describe('cache schema versioning', () => {
    // Minimal cache chains, deliberately different from CHAINLIST_SAMPLE so
    // "served from cache" vs "refetched" is observable in the data.
    const cachedChains = [
      {
        chainId: 10,
        name: 'OP Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: [],
        source: 'chainlist' as const,
      },
      {
        chainId: 1,
        name: 'Ethereum Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: [],
        source: 'chainlist' as const,
      },
    ];
    // Matches deps.now → TTL-fresh; only the schema version can mark these
    // caches stale.
    const freshFetchedAt = new Date(1_800_000_000_000).toISOString();

    it('refetches a TTL-fresh cache written before versioning (no version field)', async () => {
      const files = new Map<string, unknown>();
      files.set('/chains/chainlist-cache.json', {
        fetchedAt: freshFetchedAt,
        chains: cachedChains,
        tvls: { '10': 123 }, // pre-v2 field shape
      });
      const fetchSpy = vi.fn(async (url: string | URL) => ({
        ok: true,
        json: async () =>
          String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
      }));
      const { deps } = makeDeps({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        files,
      });
      const registry = new ChainRegistry(deps);
      const data = await registry.listChains();
      // Schema-stale despite fresh TTL → refetched: network sample served.
      expect(fetchSpy).toHaveBeenCalled();
      expect(data.total).toBe(4);
      const cache = files.get('/chains/chainlist-cache.json') as {
        version?: number;
        tvls?: unknown;
      };
      expect(cache.version).toBe(CHAINLIST_CACHE_VERSION);
      expect(cache.tvls).toBeUndefined();
    });

    it('refetches a TTL-fresh cache with an outdated version number', async () => {
      const files = new Map<string, unknown>();
      files.set('/chains/chainlist-cache.json', {
        version: 1,
        fetchedAt: freshFetchedAt,
        chains: cachedChains,
      });
      const fetchSpy = vi.fn(async (url: string | URL) => ({
        ok: true,
        json: async () =>
          String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
      }));
      const { deps } = makeDeps({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        files,
      });
      const registry = new ChainRegistry(deps);
      const data = await registry.listChains();
      expect(fetchSpy).toHaveBeenCalled();
      expect(data.total).toBe(4);
    });

    it('serves a TTL-fresh current-version cache without refetching', async () => {
      const files = new Map<string, unknown>();
      files.set('/chains/chainlist-cache.json', {
        version: CHAINLIST_CACHE_VERSION,
        fetchedAt: freshFetchedAt,
        chains: cachedChains,
      });
      const fetchSpy = vi.fn(async () => {
        throw new Error('must not fetch');
      });
      const { deps } = makeDeps({
        fetchImpl: fetchSpy as unknown as typeof fetch,
        files,
      });
      const registry = new ChainRegistry(deps);
      const data = await registry.listChains();
      expect(fetchSpy).not.toHaveBeenCalled();
      // Missing llama map reads as empty → name-alpha order.
      expect(data.chains.map((c) => c.chainId)).toEqual([1, 10]);
    });
  });

  it('derives iconUrl from the DefiLlama name, URL-encoding and preferring it over the slug', async () => {
    const chainlist = [
      {
        // No icon slug; llama name 'zkSync Era' → space must be URL-encoded.
        name: 'zkSync Era Mainnet',
        chain: 'ETH',
        rpc: [],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        shortName: 'zksync',
        chainId: 324,
      },
      {
        // Has BOTH an icon slug and a llama name → the llama name wins.
        name: 'BNB Smart Chain Mainnet',
        chain: 'BSC',
        rpc: [],
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        shortName: 'bnb',
        icon: 'bnbchain',
        chainId: 56,
      },
    ];
    const llama = [
      { chainId: 324, name: 'zkSync Era', tvl: 1e8 },
      { chainId: 56, name: 'Binance', tvl: 5e9 },
    ];
    const fetchImpl = (async (url: string | URL) => ({
      ok: true,
      json: async () =>
        String(url).includes('api.llama.fi') ? llama : chainlist,
    })) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    const registry = new ChainRegistry(deps);
    const zk = await registry.getChain(324);
    expect(zk?.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg'
    );
    const bsc = await registry.getChain(56);
    expect(bsc?.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_binance.jpg'
    );
  });

  it('lists custom chains before chainlist entries regardless of TVL', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 555,
      name: 'Zero TVL Local Fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const data = await registry.listChains();
    // Custom chain leads even though Ethereum has $80B TVL.
    expect(data.chains.map((c) => c.chainId)).toEqual([555, 1, 10, 7777, 42]);
  });
});

describe('builtin chain overrides', () => {
  // chainid.network still assigns 999 to Wanchain Testnet.
  const wanchain = {
    chainId: 999,
    name: 'Wanchain Testnet',
    shortName: 'twan',
    nativeCurrency: { name: 'Wancoin', symbol: 'WAN', decimals: 18 },
    rpc: ['https://gwan-ssl.wandevs.org:46891/'],
    iconUrl: 'https://icons.llamao.fi/icons/chains/rsz_wanchain.jpg',
    source: 'chainlist' as const,
  };
  const ethereum = {
    chainId: 1,
    name: 'Ethereum Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://eth.llamarpc.com'],
    source: 'chainlist' as const,
  };
  const freshCache = () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      version: CHAINLIST_CACHE_VERSION,
      fetchedAt: new Date(1_800_000_000_000).toISOString(),
      chains: [wanchain, ethereum],
    });
    return files;
  };

  it('replaces a misassigned entry wholesale and adds chains the dataset lacks', () => {
    const overrides = {
      999: {
        name: 'HyperEVM',
        nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
        rpc: ['https://rpc.hyperliquid.xyz/evm'],
      },
      424242: {
        name: 'Not On Chainlist',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: [],
      },
    };
    const result = applyBuiltinOverrides([wanchain, ethereum], overrides);
    expect(result.map((c) => c.chainId)).toEqual([999, 1, 424242]);
    // Nothing from the wrong entry leaks through: no Wanchain shortName,
    // RPC or icon under the HyperEVM name.
    expect(result[0]).toEqual({
      chainId: 999,
      ...overrides[999],
      source: 'chainlist',
    });
    expect(result[1]).toBe(ethereum);
    expect(result[2]).toEqual({
      chainId: 424242,
      ...overrides[424242],
      source: 'chainlist',
    });
  });

  it('ships HyperEVM for chainId 999 as a registry entry', async () => {
    const { deps } = makeDeps({
      files: freshCache(),
      chainOverrides: BUILTIN_CHAIN_OVERRIDES,
    });
    const registry = new ChainRegistry(deps);
    const chain = await registry.getChain(999);
    expect(chain?.name).toBe('HyperEVM');
    expect(chain?.nativeCurrency.symbol).toBe('HYPE');
    expect(chain?.rpc[0]).toBe('https://rpc.hyperliquid.xyz/evm');
    expect(chain?.source).toBe('chainlist');

    const list = await registry.listChains();
    expect(list.chains.filter((c) => c.chainId === 999)).toHaveLength(1);
    expect(list.chains.some((c) => c.name === 'Wanchain Testnet')).toBe(false);
    // It is a registry entry, not a user record, so it cannot be deleted.
    await expect(registry.deleteCustomChain(999)).rejects.toMatchObject({
      code: 'CHAIN_NOT_CUSTOM',
    });
  });

  it('a user record layers on top of a shipped correction', async () => {
    const { deps } = makeDeps({
      files: freshCache(),
      chainOverrides: BUILTIN_CHAIN_OVERRIDES,
    });
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999,
      name: 'HyperEVM',
      nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
      explorers: [{ name: 'purrsec', url: 'https://purrsec.com' }],
    });
    const layered = await registry.getChain(999);
    expect(layered?.explorers).toEqual([
      { name: 'purrsec', url: 'https://purrsec.com' },
    ]);
    // Same name → the shipped RPC suggestions and icon carry over.
    expect(layered?.rpc[0]).toBe('https://rpc.hyperliquid.xyz/evm');
    expect(layered?.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_hyperliquid.jpg'
    );
    expect(layered?.source).toBe('custom');

    // Deleting the user record reveals the shipped correction, never the
    // raw dataset entry.
    await registry.deleteCustomChain(999);
    expect((await registry.getChain(999))?.name).toBe('HyperEVM');
  });
});
