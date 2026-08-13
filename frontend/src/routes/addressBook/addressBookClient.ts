import type { AddressBookEntry, AddressBookView } from '@ignite/api';
import { ApiError } from '@ignite/api/client';
import { apiClient } from '../../store/api/client';
import { addressBookSourceKey } from '../deploy/addressBookEligibility';

type AddressBookApi = Pick<typeof apiClient, 'request'>;

export async function saveAddressBookWithCas(
  initialBook: AddressBookView,
  incoming: AddressBookEntry[],
  merge: (
    incomingEntries: AddressBookEntry[],
    currentEntries: AddressBookEntry[]
  ) => Promise<AddressBookEntry[]>,
  client: AddressBookApi = apiClient
): Promise<{ bookHash: string; entries: AddressBookEntry[] }> {
  let book = initialBook;
  let entries = incoming;
  for (;;) {
    try {
      return await putAddressBook(book, entries, client);
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 409) throw cause;
      const response = await client.request('getAddressBook', {});
      if (!('data' in response)) throw new Error(response.message);
      const current = response.data.books.find(
        (candidate) =>
          addressBookSourceKey(candidate) === addressBookSourceKey(book)
      );
      if (!current?.entries)
        throw new Error(
          'The current address book could not be loaded for merging.'
        );
      entries = await merge(entries, current.entries);
      book = current;
    }
  }
}

async function putAddressBook(
  book: AddressBookView,
  entries: AddressBookEntry[],
  client: AddressBookApi
): Promise<{ bookHash: string; entries: AddressBookEntry[] }> {
  const body = { entries, baseHash: book.bookHash };
  const response =
    book.source.kind === 'local'
      ? await client.request('putLocalAddressBook', { body })
      : await client.request('putRepoAddressBook', {
          body: { ...body, repoPathOrUrl: book.source.repoPathOrUrl },
        });
  if (!('data' in response)) throw new Error(response.message);
  return response.data;
}
