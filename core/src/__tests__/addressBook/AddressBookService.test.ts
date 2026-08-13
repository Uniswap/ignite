import { describe, expect, it } from 'vitest';
import { AddressBookService } from '../../addressBook/AddressBookService.js';
import { hashAddressBookRaw } from '../../addressBook/AddressBookStore.js';
import { resolveBookPointers } from '../../addressBook/BookResolver.js';
import type { DeploymentPlan, FrozenInputs } from '@ignite/api';

describe('AddressBookService invalid repo isolation', () => {
  it('surfaces malformed and oversized repo books without crashing aggregate reads', async () => {
    const malformed = '{not json';
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const contents = new Map([
      ['/malformed', malformed],
      ['/oversized', oversized],
    ]);
    const service = new AddressBookService({
      local: {
        read: async () => ({
          file: { schemaVersion: 1, entries: [] },
          raw: '',
          bookHash: hashAddressBookRaw(''),
        }),
        write: async () => ({ entries: [], bookHash: hashAddressBookRaw('') }),
      },
      registry: {
        list: async () =>
          ({
            session: null,
            local: [{ pathOrUrl: '/malformed' }, { pathOrUrl: '/oversized' }],
            cloned: [],
          }) as never,
      },
      repos: {
        getFile: async (repo) => ({
          success: true as const,
          data: { content: contents.get(repo)! },
        }),
        isWritableWorkspace: () => true,
        withWorkflowWriteLock: async () => {
          throw new Error('not used');
        },
      },
    });

    const books = await service.aggregate('profile');
    expect(books).toHaveLength(3);
    expect(books[1]).toMatchObject({
      bookHash: hashAddressBookRaw(malformed),
      error: expect.stringContaining('JSON'),
    });
    expect(books[2]).toMatchObject({
      bookHash: hashAddressBookRaw(oversized),
      error: expect.stringContaining('256 KiB'),
    });
    await expect(
      service.contextual('profile', { repoPathOrUrl: '/malformed' })
    ).rejects.toMatchObject({ code: 'ADDRESS_BOOK_JSON_INVALID' });
    const plan: DeploymentPlan = {
      schemaVersion: 1,
      chains: [1],
      signers: {},
      contracts: [
        {
          id: 'c',
          repoPathOrUrl: '/repo',
          frameworkId: 'foundry',
          artifactPath: 'C.json',
          contractName: 'C',
          sourcePath: 'C.sol',
        },
      ],
      steps: [
        {
          id: 'deploy',
          kind: 'deploy',
          contractId: 'c',
          args: { owner: { $book: { name: 'owner' } } },
        },
      ],
    };
    const frozen: FrozenInputs = {
      c: {
        abi: [
          { type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] },
        ],
        creationBytecode: '0x00',
        compiler: {
          pluginId: 'foundry',
          version: '1',
          settingsHash: 'a'.repeat(64),
        },
        artifactHash: 'b'.repeat(64),
        repoDirty: false,
      },
    };
    await expect(
      resolveBookPointers(
        plan,
        frozen,
        'profile',
        { repoPathOrUrl: '/malformed' } as never,
        { books: service }
      )
    ).rejects.toMatchObject({ code: 'ADDRESS_BOOK_JSON_INVALID' });
  });
});
