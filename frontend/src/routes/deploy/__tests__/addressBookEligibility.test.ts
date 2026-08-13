// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { AddressBookView } from '@ignite/api';
import { addressBookPickerChoices } from '../addressBookEligibility';

const localOne = '0x1111111111111111111111111111111111111111' as const;
const localTen = '0x1010101010101010101010101010101010101010' as const;
const repoAddress = '0x2222222222222222222222222222222222222222' as const;
const books: AddressBookView[] = [
  {
    source: { kind: 'local' },
    writable: true,
    bookHash: 'a'.repeat(64),
    entries: [
      { name: 'treasury', perChain: { '1': localOne, '10': localTen } },
    ],
  },
  {
    source: { kind: 'repo', repoPathOrUrl: '/repos/protocol' },
    writable: true,
    bookHash: 'b'.repeat(64),
    entries: [{ name: 'treasury', address: repoAddress }],
  },
];

describe('address book picker eligibility', () => {
  it('disambiguates duplicate names, bakes only stable globals, and links only the contextual book', () => {
    const choices = addressBookPickerChoices(books, {
      selectedChainIds: [1, 10],
      contextualSourceKey: 'local',
      allowLink: true,
    });
    expect(
      choices.map((choice) => ({
        source: choice.sourceLabel,
        plainAddress: choice.plainAddress,
        canLink: choice.canLink,
      }))
    ).toEqual([
      { source: 'local', plainAddress: undefined, canLink: true },
      { source: 'repo protocol', plainAddress: repoAddress, canLink: false },
    ]);
  });

  it('allows differing global link resolutions and ignores a masked unresolved chain', () => {
    const maskedBooks: AddressBookView[] = [
      {
        source: { kind: 'local' },
        writable: true,
        bookHash: 'a'.repeat(64),
        entries: [{ name: 'owner', perChain: { '1': localOne } }],
      },
    ];
    const choice = addressBookPickerChoices(maskedBooks, {
      selectedChainIds: [1, 10],
      maskedChainIds: [10],
      contextualSourceKey: 'local',
      allowLink: true,
    })[0]!;
    expect(choice.canLink).toBe(true);
    expect(choice.plainAddress).toBeUndefined();
  });

  it('uses the one effective chain for a per-chain override field', () => {
    const choices = addressBookPickerChoices(books, {
      selectedChainIds: [1, 10],
      chainId: 10,
      contextualSourceKey: 'repo:/repos/protocol',
      allowLink: true,
    });
    expect(choices).toEqual([
      expect.objectContaining({
        sourceLabel: 'local',
        plainAddress: localTen,
        canLink: false,
      }),
      expect.objectContaining({
        sourceLabel: 'repo protocol',
        plainAddress: repoAddress,
        canLink: true,
      }),
    ]);
  });
});
