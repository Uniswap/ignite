import { describe, expect, it } from 'vitest';
import { AddressBookService } from '../../addressBook/AddressBookService.js';
import { EMPTY_ADDRESS_BOOK_HASH, hashAddressBookRaw } from '../../addressBook/AddressBookStore.js';
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
        rawBytes: async () => Buffer.alloc(0),
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

  it('hashes the exact bytes of an invalid local book', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x7b]);
    const service = new AddressBookService({
      local: { read: async () => { throw new Error('invalid local book'); }, rawBytes: async () => raw, write: async () => ({ entries: [], bookHash: EMPTY_ADDRESS_BOOK_HASH }) },
      registry: { list: async () => ({ session: null, local: [], cloned: [] }) as never },
      repos: { getFile: async () => ({ success: false as const, error: { code: 'FILE_NOT_FOUND', message: 'missing' } }), isWritableWorkspace: () => true, withWorkflowWriteLock: async () => { throw new Error('not used'); } },
    });
    await expect(service.aggregate('profile')).resolves.toEqual([{ source: { kind: 'local' }, writable: true, bookHash: hashAddressBookRaw(raw), error: 'invalid local book' }]);
  });

  it('creates a missing repo book and keeps the authorized profile through a profile switch', async () => {
    const calls: string[] = [];
    let registryReads = 0;
    let activeProfile = 'profile-one';
    let capturedProfile: string | undefined;
    const service = new AddressBookService({
      local: { read: async () => ({ file: { schemaVersion: 1, entries: [] }, raw: '', bookHash: EMPTY_ADDRESS_BOOK_HASH }), rawBytes: async () => Buffer.alloc(0), write: async () => ({ entries: [], bookHash: EMPTY_ADDRESS_BOOK_HASH }) },
      registry: { list: async (profileId) => { registryReads += 1; calls.push(`registry:${profileId}`); if (registryReads === 1) activeProfile = 'profile-two'; return { session: null, local: [], cloned: [{ pathOrUrl: 'https://example.test/repo.git' }] } as never; } },
      repos: {
        getFile: async (_repo, _file, profileId) => { capturedProfile = profileId; calls.push(`read:${profileId}:active-${activeProfile}`); return { success: false as const, error: { code: 'FILE_NOT_FOUND', message: 'missing' } }; },
        isWritableWorkspace: () => true,
        withWorkflowWriteLock: async (_repo, fn, profileId) => { capturedProfile = profileId; calls.push(`lock:${profileId}:active-${activeProfile}`); return fn({ readFile: async () => null, writeFile: async () => { calls.push('write'); }, restoreFile: async () => undefined }); },
      },
    });
    await service.contextual('profile-one', { repoPathOrUrl: 'https://example.test/repo.git' });
    expect(capturedProfile).toBe('profile-one');
    await expect(service.writeRepo('profile-one', 'https://example.test/repo.git', [{ name: 'owner', address: '0x1111111111111111111111111111111111111111' }], EMPTY_ADDRESS_BOOK_HASH)).resolves.toMatchObject({ entries: [{ name: 'owner' }] });
    expect(registryReads).toBe(3);
    expect(calls).toContain('read:profile-one:active-profile-two');
    expect(calls).toContain('lock:profile-one:active-profile-two');
  });
});
