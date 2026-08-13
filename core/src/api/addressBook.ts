import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AddressBookAggregateData,
  IApiResponse,
  PutAddressBookData,
  PutLocalAddressBookRequest,
  PutRepoAddressBookRequest,
} from '@ignite/api';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { AddressBookService } from '../addressBook/AddressBookService.js';
import { AddressBookError } from '../addressBook/AddressBookStore.js';

export interface AddressBookHandlerDeps {
  service: Pick<AddressBookService, 'aggregate' | 'writeLocal' | 'writeRepo'>;
  getProfileId: () => Promise<string>;
}

function fail(reply: FastifyReply, error: unknown) {
  const known = error instanceof AddressBookError
    ? error
    : new AddressBookError(400, 'ADDRESS_BOOK_FAILED', error instanceof Error ? error.message : String(error));
  return reply.status(known.statusCode).send({
    statusCode: known.statusCode,
    error: known.statusCode === 409 ? 'Conflict' : known.statusCode === 422 ? 'Unprocessable Entity' : 'Bad Request',
    code: known.code,
    message: known.message,
  });
}

export function createAddressBookHandlers(deps?: Partial<AddressBookHandlerDeps>) {
  const d: AddressBookHandlerDeps = {
    service: deps?.service ?? new AddressBookService(),
    getProfileId: deps?.getProfileId ?? (async () => (await ProfileManager.getInstance()).getCurrentProfile()),
  };
  return {
    getAddressBook: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<AddressBookAggregateData>> => {
      try {
        return reply.status(200).send({ data: { books: await d.service.aggregate(await d.getProfileId()) } });
      } catch (error) { return fail(reply, error); }
    },
    putLocalAddressBook: async (request: FastifyRequest<{ Body: PutLocalAddressBookRequest }>, reply: FastifyReply): Promise<IApiResponse<PutAddressBookData>> => {
      try {
        const body = request.body;
        return reply.status(200).send({ data: await d.service.writeLocal(await d.getProfileId(), body.entries, body.baseHash, body.force) });
      } catch (error) { return fail(reply, error); }
    },
    putRepoAddressBook: async (request: FastifyRequest<{ Body: PutRepoAddressBookRequest }>, reply: FastifyReply): Promise<IApiResponse<PutAddressBookData>> => {
      try {
        const body = request.body;
        return reply.status(200).send({ data: await d.service.writeRepo(await d.getProfileId(), body.repoPathOrUrl, body.entries, body.baseHash, body.force) });
      } catch (error) { return fail(reply, error); }
    },
  } as const;
}

export const addressBookHandlers = createAddressBookHandlers();
