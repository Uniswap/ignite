import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AddressBookFileSchema } from '@ignite/api';
import {
  AddressBookStore,
  EMPTY_ADDRESS_BOOK_HASH,
} from '../../addressBook/AddressBookStore.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe('AddressBookStore', () => {
  it('creates a missing book when the client presents the empty-book hash', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ignite-address-book-store-')
    );
    directories.push(directory);
    const file = path.join(directory, 'addressbook.json');
    const store = new AddressBookStore({
      fileSystem: { getProfileAddressBookPath: () => file },
    });

    await expect(
      store.write(
        'profile',
        [
          {
            name: 'owner',
            address: '0x1111111111111111111111111111111111111111',
          },
        ],
        EMPTY_ADDRESS_BOOK_HASH
      )
    ).resolves.toMatchObject({
      entries: [{ name: 'owner' }],
    });
    await expect(fs.readFile(file, 'utf8')).resolves.toContain('owner');
  });

  it('rejects the zero address with a clear schema error', () => {
    const result = AddressBookFileSchema.safeParse({
      schemaVersion: 1,
      entries: [
        {
          name: 'zero',
          address: '0x0000000000000000000000000000000000000000',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.message).toContain(
        'zero address is not allowed'
      );
  });
});
