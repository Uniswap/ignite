import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ComposeDeploymentData, ComposeDeploymentRequest, IApiResponse, ListDeploymentTypesData } from '@ignite/api';
import { DeploymentTypeService } from '../deployments/DeploymentTypeService.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { IgniteError } from '../types/errors.js';
import { sendCaughtError } from './utils/errors.js';

// Typed IgniteError codes keep their meaning on the wire: composition
// failures are authoring-time input problems (bounded, sanitized messages),
// not server faults, and the composer UI renders them inline.
function sendDeploymentTypeError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof IgniteError) {
    const status = error.code === 'PLUGIN_NOT_FOUND' ? 404 : error.code === 'DEPLOYMENT_TYPE_OP_FAILED' || error.code === 'UNKNOWN_PARAM_KEY' || error.code === 'INVALID_PARAM_VALUE' ? 400 : undefined;
    if (status) return reply.status(status).send({ statusCode: status, error: status === 404 ? 'Not Found' : 'Bad Request', code: error.code, message: error.message });
  }
  return sendCaughtError(reply, error, 'DEPLOYMENT_TYPE_OP_FAILED' as never, fallback);
}

export const deploymentTypeHandlers = {
  listDeploymentTypes: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<ListDeploymentTypesData>> => {
    try { return reply.status(200).send({ data: { deploymentTypes: await DeploymentTypeService.getInstance().list() } }); }
    catch (error) { return sendCaughtError(reply, error, 'DEPLOYMENT_TYPE_OP_FAILED' as never, 'Failed to list deployment types'); }
  },
  composeDeployment: async (request: FastifyRequest<{ Body: ComposeDeploymentRequest }>, reply: FastifyReply): Promise<IApiResponse<ComposeDeploymentData>> => {
    try {
      const profileId = (await ProfileManager.getInstance()).getCurrentProfile();
      const data = await DeploymentTypeService.getInstance().compose(profileId, request.body);
      return reply.status(200).send({ data });
    } catch (error) { return sendDeploymentTypeError(reply, error, 'Failed to compose the deployment'); }
  },
} as const;
