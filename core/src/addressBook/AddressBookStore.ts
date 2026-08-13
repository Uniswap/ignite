import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAddress } from 'viem';
import {
  AddressBookFileSchema,
  type AddressBookEntry,
  type AddressBookFile,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { KeyedMutex } from '../utils/KeyedMutex.js';

export const MAX_ADDRESS_BOOK_BYTES = 256 * 1024;

export class AddressBookError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function hashAddressBookRaw(raw: string | Uint8Array): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export const EMPTY_ADDRESS_BOOK_HASH = hashAddressBookRaw('');

export function normalizeAddressBookEntries(entries: AddressBookEntry[]): AddressBookEntry[] {
  // getAddress's mixed-case checksum validation is intentional strictness.
  // The v1 UI does not normalize an incorrectly checksummed mixed-case value.
  return entries.map((entry) => ({
    ...entry,
    ...(entry.address ? { address: getAddress(entry.address) } : {}),
    ...(entry.perChain
      ? { perChain: Object.fromEntries(Object.entries(entry.perChain).map(([chain, address]) => [chain, getAddress(address)])) }
      : {}),
  }));
}

export function parseAddressBook(raw: string): AddressBookFile {
  if (Buffer.byteLength(raw) > MAX_ADDRESS_BOOK_BYTES)
    throw new AddressBookError(422, 'ADDRESS_BOOK_TOO_LARGE', 'Address book exceeds 256 KiB');
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new AddressBookError(422, 'ADDRESS_BOOK_JSON_INVALID', error instanceof Error ? error.message : String(error)); }
  const parsed = AddressBookFileSchema.safeParse(value);
  if (!parsed.success)
    throw new AddressBookError(422, 'ADDRESS_BOOK_INVALID', parsed.error.message);
  try {
    return { schemaVersion: 1, entries: normalizeAddressBookEntries(parsed.data.entries) };
  } catch (error) {
    throw new AddressBookError(422, 'ADDRESS_BOOK_INVALID', error instanceof Error ? error.message : String(error));
  }
}

export interface AddressBookStoreDeps {
  fileSystem: Pick<FileSystem, 'getProfileAddressBookPath'>;
}

export class AddressBookStore {
  private static readonly mutex = new KeyedMutex();
  private readonly deps: AddressBookStoreDeps;

  constructor(deps?: Partial<AddressBookStoreDeps>) {
    this.deps = { fileSystem: deps?.fileSystem ?? FileSystem.getInstance() };
  }

  async read(profileId: string): Promise<{ file: AddressBookFile; raw: string; bookHash: string }> {
    let raw: string;
    try { raw = await fs.readFile(this.file(profileId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') raw = '';
      else throw error;
    }
    if (!raw) return { file: { schemaVersion: 1, entries: [] }, raw, bookHash: hashAddressBookRaw(raw) };
    return { file: parseAddressBook(raw), raw, bookHash: hashAddressBookRaw(raw) };
  }

  async raw(profileId: string): Promise<string> {
    try { return await fs.readFile(this.file(profileId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async rawBytes(profileId: string): Promise<Buffer> {
    try { return await fs.readFile(this.file(profileId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
  }

  async write(profileId: string, entries: AddressBookEntry[], baseHash?: string, force?: boolean): Promise<{ bookHash: string; entries: AddressBookEntry[] }> {
    let normalized: AddressBookEntry[];
    try { normalized = normalizeAddressBookEntries(AddressBookFileSchema.parse({ schemaVersion: 1, entries }).entries); }
    catch (error) { throw new AddressBookError(400, 'ADDRESS_BOOK_INVALID', error instanceof Error ? error.message : String(error)); }
    const raw = `${JSON.stringify({ schemaVersion: 1, entries: normalized }, null, 2)}\n`;
    if (Buffer.byteLength(raw) > MAX_ADDRESS_BOOK_BYTES)
      throw new AddressBookError(400, 'ADDRESS_BOOK_TOO_LARGE', 'Address book exceeds 256 KiB');
    return AddressBookStore.mutex.run(profileId, async () => {
      const file = this.file(profileId);
      let current: string | null;
      try { current = await fs.readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null;
        else throw error;
      }
      if (current !== null) {
        const currentHash = hashAddressBookRaw(current);
        const valid = (() => { try { parseAddressBook(current); return true; } catch { return false; } })();
        if (!valid && force === true) {
          // Force is intentionally only the explicit invalid-file repair path.
        } else if (!baseHash) {
          throw new AddressBookError(409, 'ADDRESS_BOOK_BASE_HASH_REQUIRED', 'baseHash is required when updating an existing address book');
        } else if (currentHash !== baseHash) {
          throw new AddressBookError(409, 'ADDRESS_BOOK_CONFLICT', 'Address book changed since it was loaded');
        }
      } else if (baseHash && baseHash !== EMPTY_ADDRESS_BOOK_HASH) {
        throw new AddressBookError(409, 'ADDRESS_BOOK_DELETED', 'Address book was deleted since it was loaded');
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      try {
        await fs.writeFile(temporary, raw, 'utf8');
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return { bookHash: hashAddressBookRaw(raw), entries: normalized };
    });
  }

  private file(profileId: string): string { return this.deps.fileSystem.getProfileAddressBookPath(profileId); }
}
