import { getAddress } from 'viem';
import { AddressBookFileSchema, type AddressBookEntry, type AddressBookFile, type AddressBookView, type WorkflowRunBinding } from '@ignite/api';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { RepoService } from '../repos/RepoService.js';
import { AddressBookError, AddressBookStore, MAX_ADDRESS_BOOK_BYTES, hashAddressBookRaw, normalizeAddressBookEntries, parseAddressBook } from './AddressBookStore.js';

export const addressBookRelPath = 'ignite/addressbook.json';
export type ContextualBook = {
  source: 'local' | 'repo';
  sourceKey: string;
  bookHash: string;
  file: AddressBookFile;
};

export interface AddressBookServiceDeps {
  local: Pick<AddressBookStore, 'read' | 'write'>;
  repos: Pick<RepoService, 'getFile' | 'withWorkflowWriteLock' | 'isWritableWorkspace'>;
  registry: Pick<ProfileRepoRegistry, 'list'>;
}

export class AddressBookService {
  private readonly deps: AddressBookServiceDeps;

  constructor(deps?: Partial<AddressBookServiceDeps>) {
    this.deps = {
      local: deps?.local ?? new AddressBookStore(),
      repos: deps?.repos ?? RepoService.getInstance(),
      registry: deps?.registry ?? new ProfileRepoRegistry(),
    };
  }

  async aggregate(profileId: string): Promise<AddressBookView[]> {
    const books: AddressBookView[] = [];
    try {
      const local = await this.deps.local.read(profileId);
      books.push({
        source: { kind: 'local' },
        writable: true,
        bookHash: local.bookHash,
        entries: local.file.entries,
      });
    } catch (error) {
      const raw = await this.localRaw(profileId);
      books.push({
        source: { kind: 'local' },
        writable: true,
        bookHash: hashAddressBookRaw(raw),
        error: message(error),
      });
    }
    let records: Array<{ pathOrUrl: string }> = [];
    try {
      const registered = await this.deps.registry.list(profileId);
      records = [...registered.local, ...registered.cloned];
    } catch {
      // The local book remains usable even if repository registry data is unavailable.
      return books;
    }
    for (const record of records) books.push(await this.viewRepo(record.pathOrUrl));
    return books;
  }

  async contextual(profileId: string, workflow?: Pick<WorkflowRunBinding, 'repoPathOrUrl'>): Promise<ContextualBook> {
    if (!workflow) {
      const local = await this.deps.local.read(profileId);
      return {
        source: 'local',
        sourceKey: 'local',
        bookHash: local.bookHash,
        file: local.file,
      };
    }
    await this.assertRegistered(profileId, workflow.repoPathOrUrl);
    const result = await this.deps.repos.getFile(workflow.repoPathOrUrl, addressBookRelPath);
    if (!result.success && result.error.code !== 'FILE_NOT_FOUND') throw new AddressBookError(422, 'ADDRESS_BOOK_READ_FAILED', result.error.message);
    const raw = result.success ? result.data.content : '';
    return {
      source: 'repo',
      sourceKey: `repo:${workflow.repoPathOrUrl}`,
      bookHash: hashAddressBookRaw(raw),
      file: raw ? parseAddressBook(raw) : { schemaVersion: 1, entries: [] },
    };
  }

  async writeLocal(profileId: string, entries: AddressBookEntry[], baseHash?: string, force?: boolean) {
    return this.deps.local.write(profileId, entries, baseHash, force);
  }

  async writeRepo(profileId: string, repoPathOrUrl: string, entries: AddressBookEntry[], baseHash?: string, force?: boolean): Promise<{ bookHash: string; entries: AddressBookEntry[] }> {
    await this.assertRegistered(profileId, repoPathOrUrl);
    if (!this.deps.repos.isWritableWorkspace(repoPathOrUrl)) throw new AddressBookError(400, 'ADDRESS_BOOK_TARGET_UNWRITABLE', 'Address book target is read-only');
    let normalized: AddressBookEntry[];
    try {
      normalized = normalizeAddressBookEntries(AddressBookFileSchema.parse({ schemaVersion: 1, entries }).entries);
    } catch (error) {
      throw new AddressBookError(400, 'ADDRESS_BOOK_INVALID', message(error));
    }
    const raw = `${JSON.stringify({ schemaVersion: 1, entries: normalized }, null, 2)}\n`;
    if (Buffer.byteLength(raw) > MAX_ADDRESS_BOOK_BYTES) throw new AddressBookError(400, 'ADDRESS_BOOK_TOO_LARGE', 'Address book exceeds 256 KiB');
    return this.deps.repos.withWorkflowWriteLock(repoPathOrUrl, async ({ readFile, writeFile }) => {
      const current = await readFile(addressBookRelPath);
      if (current !== null) {
        const valid = (() => {
          try {
            parseAddressBook(current);
            return true;
          } catch {
            return false;
          }
        })();
        if (!valid && force === true) {
          // An explicitly invalid file may be repaired without a stale hash.
        } else if (!baseHash) {
          throw new AddressBookError(409, 'ADDRESS_BOOK_BASE_HASH_REQUIRED', 'baseHash is required when updating an existing address book');
        } else if (hashAddressBookRaw(current) !== baseHash) {
          throw new AddressBookError(409, 'ADDRESS_BOOK_CONFLICT', 'Address book changed since it was loaded');
        }
      } else if (baseHash) {
        throw new AddressBookError(409, 'ADDRESS_BOOK_DELETED', 'Address book was deleted since it was loaded');
      }
      await writeFile(addressBookRelPath, raw);
      return { bookHash: hashAddressBookRaw(raw), entries: normalized };
    });
  }

  private async viewRepo(repoPathOrUrl: string): Promise<AddressBookView> {
    const writable = this.deps.repos.isWritableWorkspace(repoPathOrUrl);
    let raw = '';
    try {
      const result = await this.deps.repos.getFile(repoPathOrUrl, addressBookRelPath);
      if (!result.success && result.error.code !== 'FILE_NOT_FOUND')
        return {
          source: { kind: 'repo', repoPathOrUrl },
          writable,
          bookHash: hashAddressBookRaw(''),
          error: result.error.message,
        };
      raw = result.success ? result.data.content : '';
      return {
        source: { kind: 'repo', repoPathOrUrl },
        writable,
        bookHash: hashAddressBookRaw(raw),
        entries: raw ? parseAddressBook(raw).entries : [],
      };
    } catch (error) {
      return {
        source: { kind: 'repo', repoPathOrUrl },
        writable,
        bookHash: hashAddressBookRaw(raw),
        error: message(error),
      };
    }
  }

  private async assertRegistered(profileId: string, repoPathOrUrl: string): Promise<void> {
    const repos = await this.deps.registry.list(profileId);
    if (![...repos.local, ...repos.cloned].some((repo) => repo.pathOrUrl === repoPathOrUrl)) throw new AddressBookError(400, 'ADDRESS_BOOK_TARGET_UNREGISTERED', 'Address book target is not registered in the current profile');
  }

  private async localRaw(profileId: string): Promise<string> {
    try {
      return (await this.deps.local.read(profileId)).raw;
    } catch {
      return '';
    }
  }
}

export function resolveBookEntry(entry: AddressBookEntry, chainId: number): `0x${string}` | undefined {
  const value = entry.perChain?.[String(chainId)] ?? entry.address;
  return value ? getAddress(value) : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
