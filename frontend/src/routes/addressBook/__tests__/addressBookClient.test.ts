// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@ignite/api/client';
import { saveAddressBookWithCas } from '../addressBookClient';

describe('bulk address book CAS saves', () => {
  it('refetches on 409, merges per entry, and retries with the new base hash', async () => {
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const incoming = [
      {
        name: 'token',
        address: '0x1111111111111111111111111111111111111111' as const,
      },
    ];
    const current = [
      {
        name: 'admin',
        address: '0x2222222222222222222222222222222222222222' as const,
      },
    ];
    const merged = [...current, ...incoming];
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError('conflict', 409, {
          code: 'ADDRESS_BOOK_CONFLICT',
          message: 'changed',
          statusCode: 409,
          error: 'Conflict',
        })
      )
      .mockResolvedValueOnce({
        data: {
          books: [
            {
              source: { kind: 'local' },
              writable: true,
              bookHash: newHash,
              entries: current,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { bookHash: 'c'.repeat(64), entries: merged },
      });
    const merge = vi.fn(async () => merged);

    await expect(
      saveAddressBookWithCas(
        {
          source: { kind: 'local' },
          writable: true,
          bookHash: oldHash,
          entries: [],
        },
        incoming,
        merge,
        { request } as never
      )
    ).resolves.toMatchObject({ entries: merged });

    expect(merge).toHaveBeenCalledWith(incoming, current);
    expect(request).toHaveBeenNthCalledWith(3, 'putLocalAddressBook', {
      body: { entries: merged, baseHash: newHash },
    });
  });
});
