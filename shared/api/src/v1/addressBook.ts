import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema, createRequestSchema } from '../utils/schema.js';
import type { Hex } from './deployments.js';

export const AddressBookEntryNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const AddressBookAddressPattern = /^0x[0-9a-fA-F]{40}$/;
export const AddressBookChainIdPattern = /^[1-9][0-9]*$/;

export interface AddressBookEntry {
  name: string;
  address?: Hex;
  perChain?: Record<string, Hex>;
  note?: string;
}

export interface AddressBookFile {
  schemaVersion: 1;
  entries: AddressBookEntry[];
}

export type AddressBookSource =
  | { kind: 'local' }
  | { kind: 'repo'; repoPathOrUrl: string };

export interface AddressBookView {
  source: AddressBookSource;
  writable: boolean;
  bookHash: string;
  entries?: AddressBookEntry[];
  error?: string;
}

export interface AddressBookAggregateData {
  books: AddressBookView[];
}

export interface PutLocalAddressBookRequest {
  entries: AddressBookEntry[];
  baseHash?: string;
  force?: boolean;
}

export interface PutRepoAddressBookRequest extends PutLocalAddressBookRequest {
  repoPathOrUrl: string;
}

export interface PutAddressBookData {
  bookHash: string;
  entries: AddressBookEntry[];
}

const AddressSchema = z.string().regex(AddressBookAddressPattern) as z.ZodType<Hex>;
const ChainIdSchema = z.string().regex(AddressBookChainIdPattern);
const Sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/);

export const AddressBookEntrySchema = z.object({
  name: z.string().regex(AddressBookEntryNamePattern),
  address: AddressSchema.optional(),
  perChain: z.record(ChainIdSchema, AddressSchema).optional(),
  note: z.string().max(256).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.address === undefined && Object.keys(entry.perChain ?? {}).length === 0)
    ctx.addIssue({ code: 'custom', message: 'entry must have an address or at least one perChain override', path: ['address'] });
  if (Object.keys(entry.perChain ?? {}).length > 64)
    ctx.addIssue({ code: 'custom', message: 'entry may have at most 64 perChain overrides', path: ['perChain'] });
}) satisfies z.ZodType<AddressBookEntry>;

export const AddressBookFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(AddressBookEntrySchema).max(512),
}).strict().superRefine((file, ctx) => {
  const names = new Set<string>();
  for (const [index, entry] of file.entries.entries()) {
    if (names.has(entry.name))
      ctx.addIssue({ code: 'custom', message: 'entry names must be unique', path: ['entries', index, 'name'] });
    names.add(entry.name);
  }
}) satisfies z.ZodType<AddressBookFile>;

const AddressBookSourceSchema = z.union([
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('repo'), repoPathOrUrl: z.string().min(1) }).strict(),
]) satisfies z.ZodType<AddressBookSource>;
const AddressBookViewSchema = z.object({
  source: AddressBookSourceSchema,
  writable: z.boolean(),
  bookHash: Sha256Schema,
  entries: z.array(AddressBookEntrySchema).max(512).optional(),
  error: z.string().min(1).optional(),
}).strict() satisfies z.ZodType<AddressBookView>;

export const GetAddressBookResponseSchema = createApiResponseSchema<AddressBookAggregateData>('GetAddressBookResponseSchema')(
  z.object({ books: z.array(AddressBookViewSchema).max(513) }).strict(),
);

const PutBodySchema = z.object({
  entries: z.array(AddressBookEntrySchema).max(512),
  baseHash: Sha256Schema.optional(),
  force: z.literal(true).optional(),
}).strict();

export const PutLocalAddressBookRequestSchema = createRequestSchema<PutLocalAddressBookRequest>('PutLocalAddressBookRequestSchema')(
  PutBodySchema,
);
export const PutRepoAddressBookRequestSchema = createRequestSchema<PutRepoAddressBookRequest>('PutRepoAddressBookRequestSchema')(
  PutBodySchema.extend({ repoPathOrUrl: z.string().min(1) }).strict(),
);
export const PutAddressBookResponseSchema = createApiResponseSchema<PutAddressBookData>('PutAddressBookResponseSchema')(
  z.object({ bookHash: Sha256Schema, entries: z.array(AddressBookEntrySchema).max(512) }).strict(),
);

export const addressBookRoutes = {
  getAddressBook: {
    method: 'GET' as const,
    path: `${V1_BASE_PATH}/addressbook`,
    schema: { response: { 200: GetAddressBookResponseSchema } },
  },
  putLocalAddressBook: {
    method: 'PUT' as const,
    path: `${V1_BASE_PATH}/addressbook/local`,
    schema: { body: PutLocalAddressBookRequestSchema, response: { 200: PutAddressBookResponseSchema } },
  },
  putRepoAddressBook: {
    method: 'PUT' as const,
    path: `${V1_BASE_PATH}/addressbook/repo`,
    schema: { body: PutRepoAddressBookRequestSchema, response: { 200: PutAddressBookResponseSchema } },
  },
} as const;
