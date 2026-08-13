import { ExternalLink } from 'lucide-react';
import type { ChainInfo } from '@ignite/api';
import Dropdown from './Dropdown';

// One openable explorer page per (chain, explorer) pair. Options carry the
// chainId so per-chain override fields can filter them the same way
// signerOptions are filtered.
export interface ExplorerLookupOption {
  chainId: number;
  key: string;
  label: string;
  addressUrlBase: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function explorerLookupOptions(
  chains: ChainInfo[],
  chainIds: number[]
): ExplorerLookupOption[] {
  const byId = new Map(chains.map((chain) => [chain.chainId, chain]));
  const options: ExplorerLookupOption[] = [];
  for (const chainId of chainIds) {
    const chain = byId.get(chainId);
    if (!chain) continue;
    const seen = new Set<string>();
    for (const explorer of chain.explorers ?? []) {
      // Only EIP3091 explorers have a known /address/ page layout — the same
      // restriction explorerAddressUrl applies for run links.
      if (explorer.standard !== 'EIP3091') continue;
      const base = explorer.url.replace(/\/+$/, '');
      if (!/^https?:\/\//.test(base) || seen.has(base)) continue;
      seen.add(base);
      options.push({
        chainId,
        key: `${chainId}:${base}`,
        label: `${chain.name} - ${explorer.name}`,
        addressUrlBase: base,
      });
    }
  }
  return options;
}

export function explorerLookupUrl(
  option: ExplorerLookupOption,
  address: string
): string {
  return `${option.addressUrlBase}/address/${address}`;
}

// Suffix button for address inputs: opens the address on a block explorer.
// A single available explorer opens directly; several open a picker menu.
// Renders nothing until the value is a complete address.
export default function ExplorerLookupSuffix({
  address,
  options = [],
}: {
  address: string;
  options?: ExplorerLookupOption[];
}) {
  if (options.length === 0 || !ADDRESS_RE.test(address)) return null;
  const buttonClass =
    'absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted hover:text-accent transition-colors';
  if (options.length === 1) {
    return (
      <a
        href={explorerLookupUrl(options[0], address)}
        target="_blank"
        rel="noreferrer"
        className={buttonClass}
        title={`Open in ${options[0].label}`}
        aria-label={`Open address in ${options[0].label}`}
      >
        <ExternalLink size={14} />
      </a>
    );
  }
  return (
    <Dropdown
      renderTrigger={({ ref, toggle, getReferenceProps }) => (
        <button
          type="button"
          ref={ref}
          {...getReferenceProps()}
          className={buttonClass}
          title="Open in a block explorer"
          aria-label="Open address in a block explorer"
          onClick={toggle}
        >
          <ExternalLink size={14} />
        </button>
      )}
      menuClassName="glass-overlay"
      menuStyle={{ padding: 8, minWidth: 200 }}
    >
      {({ close }) => (
        <div className="flex flex-col gap-1">
          {options.map((option) => (
            <a
              key={option.key}
              href={explorerLookupUrl(option, address)}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary flex items-center justify-start gap-2 w-full text-sm"
              onClick={close}
            >
              <ExternalLink size={14} />
              {option.label}
            </a>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
