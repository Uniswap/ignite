// Corrections Ignite ships on top of the chainid.network dataset. The
// upstream registry can lag or misassign an id (999 still resolves to
// Wanchain Testnet there while the live network is HyperEVM), and every
// user would otherwise have to repair it by hand. An override replaces the
// upstream entry for its chainId wholesale — a wrong identity makes the
// upstream RPCs, explorers and icon wrong too — or adds the chain when the
// dataset lacks it. The result still reads as a registry entry (`source:
// 'chainlist'`); users layer their own record on top via mergeCustomChain.
import type { ChainInfo } from '@ignite/api';

export type ChainOverride = Omit<ChainInfo, 'chainId' | 'source'>;

export const BUILTIN_CHAIN_OVERRIDES: Readonly<Record<number, ChainOverride>> =
  {
    // Mirrors chainlist.org's own correction for this id:
    // https://github.com/DefiLlama/chainlist/blob/main/constants/additionalChainRegistry/chainid-999.js
    999: {
      name: 'HyperEVM',
      shortName: 'hyper_evm',
      nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
      rpc: [
        'https://rpc.hyperliquid.xyz/evm',
        'https://rpc.hypurrscan.io',
        'https://hyperliquid-json-rpc.stakely.io',
        'https://hyperliquid.drpc.org',
        'https://rpc.hyperlend.finance',
        'https://hyperliquid.api.onfinality.io/evm/public',
        'https://hyperliquid.rpc.blxrbdn.com',
      ],
      explorers: [{ name: 'HyperEVMScan', url: 'https://hyperevmscan.io/' }],
      infoURL: 'https://hyperfoundation.org/',
      iconUrl: 'https://icons.llamao.fi/icons/chains/rsz_hyperliquid.jpg',
    },
  };

export function applyBuiltinOverrides(
  chains: ChainInfo[],
  overrides: Readonly<Record<number, ChainOverride>> = BUILTIN_CHAIN_OVERRIDES
): ChainInfo[] {
  const pending = new Map(
    Object.entries(overrides).map(
      ([chainId, override]) => [Number(chainId), override] as const
    )
  );
  const result: ChainInfo[] = chains.map((chain) => {
    const override = pending.get(chain.chainId);
    if (!override) return chain;
    pending.delete(chain.chainId);
    return { chainId: chain.chainId, ...override, source: 'chainlist' };
  });
  for (const [chainId, override] of pending) {
    result.push({ chainId, ...override, source: 'chainlist' });
  }
  return result;
}
