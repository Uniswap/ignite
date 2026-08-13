import type { AddressBookEntry, AddressBookView, Hex } from '@ignite/api';
import { getRepoName } from '../../utils/repo';

export interface AddressBookPickerContext {
  selectedChainIds: number[];
  chainId?: number;
  maskedChainIds?: number[];
  contextualSourceKey?: string;
  allowLink: boolean;
}

export interface AddressBookChoice {
  book: AddressBookView;
  entry: AddressBookEntry;
  sourceLabel: string;
  resolutions: Record<string, Hex>;
  plainAddress?: Hex;
  canLink: boolean;
}

export function addressBookSourceKey(book: AddressBookView): string {
  return book.source.kind === 'local'
    ? 'local'
    : `repo:${book.source.repoPathOrUrl}`;
}

export function addressBookPickerChoices(
  books: AddressBookView[],
  context: AddressBookPickerContext
): AddressBookChoice[] {
  const plainChains =
    context.chainId === undefined
      ? context.selectedChainIds
      : [context.chainId];
  const linkChains =
    context.chainId === undefined
      ? context.selectedChainIds.filter(
          (chainId) => !context.maskedChainIds?.includes(chainId)
        )
      : [context.chainId];

  return books.flatMap((book) =>
    (book.entries ?? []).flatMap((entry) => {
      const plainResolutions = resolveOnChains(entry, plainChains);
      const linkResolutions = resolveOnChains(entry, linkChains);
      const plainValues = Object.values(plainResolutions);
      const plainAddress =
        plainChains.length > 0 &&
        plainValues.length === plainChains.length &&
        plainValues.every(
          (address) => address.toLowerCase() === plainValues[0]!.toLowerCase()
        )
          ? plainValues[0]
          : plainChains.length === 0 && entry.address
            ? entry.address
            : undefined;
      const canLink =
        Boolean(
          context.allowLink &&
          context.contextualSourceKey === addressBookSourceKey(book) &&
          linkChains.length > 0 &&
          Object.keys(linkResolutions).length === linkChains.length
        ) ||
        Boolean(
          context.allowLink &&
          context.contextualSourceKey === addressBookSourceKey(book) &&
          linkChains.length === 0
        );
      if (!plainAddress && !canLink) return [];
      return [
        {
          book,
          entry,
          sourceLabel:
            book.source.kind === 'local'
              ? 'local'
              : `repo ${getRepoName(book.source.repoPathOrUrl)}`,
          resolutions:
            Object.keys(linkResolutions).length > 0
              ? linkResolutions
              : plainResolutions,
          ...(plainAddress ? { plainAddress } : {}),
          canLink,
        },
      ];
    })
  );
}

function resolveOnChains(
  entry: AddressBookEntry,
  chainIds: number[]
): Record<string, Hex> {
  return Object.fromEntries(
    chainIds.flatMap((chainId) => {
      const address = entry.perChain?.[String(chainId)] ?? entry.address;
      return address ? [[String(chainId), address]] : [];
    })
  );
}
