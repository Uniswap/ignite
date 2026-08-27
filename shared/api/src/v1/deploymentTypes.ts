import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema, createRequestSchema } from '../utils/schema.js';
import {
  ContractSourceSchema,
  DeploymentTypeBindingSchema,
  DeploymentTypeExecutionSchema,
  type ContractSource,
  type DeploymentTypeBinding,
  type DeploymentTypeExecution,
} from './deployments.js';

export interface DeploymentTypeParamFieldWire {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  description?: string;
}

export interface DeploymentTypeInfo {
  pluginId: string;
  // Injected by core from the installed plugin's registry metadata; a
  // plugin-authored version field in the descriptor is rejected, not trusted.
  pluginVersion: string;
  label: string;
  description: string;
  execution: DeploymentTypeExecution;
  params: DeploymentTypeParamFieldWire[];
  // Host-derived, never trusted descriptor input: validateSupported only for
  // CREATE2 mode with an effective validateDeployment operation, and
  // composeSupported only for call-products mode with an explicitly declared
  // composeDeployment operation.
  validateSupported: boolean;
  composeSupported: boolean;
}

export interface ListDeploymentTypesData {
  deploymentTypes: DeploymentTypeInfo[];
}

// The deliberately small dynamic-form vocabulary the composer renders.
// Plugins cannot provide markup, component names, executable frontend code,
// or arbitrary validation expressions.
export type DeploymentComposerField =
  | {
      type: 'artifact';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
      origins?: Array<'repo' | 'contract-type'>;
    }
  | {
      type: 'address';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
    }
  | {
      type: 'select';
      key: string;
      label: string;
      description?: string;
      required?: boolean;
      options: Array<{ value: string; label: string }>;
    };

// The frontend sends selected ContractSource identities; core resolves them
// through the artifact service and never accepts a client ABI as authority.
export interface ComposeDeploymentRequest {
  pluginId: string;
  compositionId: string;
  // Monotonically increasing per composition. The server echoes it verbatim;
  // the frontend applies a response only if its revision is still the latest,
  // so an older container result cannot overwrite newer field selections.
  revision: number;
  values: Record<string, unknown>;
  artifacts: Record<string, ContractSource>;
}

export interface ComposedProducer {
  abiArtifactField: string;
  targetField: string;
  functionField: string;
  // Derived by core from the authoritative selected ABI — never
  // plugin-supplied. The canonical input-only viem form (e.g.
  // `deploy(address)`), identical to what an ordinary call step stores, so it
  // matches frozen-ABI entries the same way; argument names, outputs, and
  // payability come from the frozen abiContractId ABI, not from this string.
  signature: string;
  payable: boolean;
}

export interface ComposedProduct {
  key: string;
  artifactField: string;
  outputIndex: number;
  params?: Record<string, unknown>;
}

// The normalized materialization core returns — not the raw plugin payload.
export interface ComposedCallProducts {
  producer: ComposedProducer;
  products: ComposedProduct[];
}

export interface ComposeDeploymentData {
  revision: number;
  binding: DeploymentTypeBinding;
  fields: DeploymentComposerField[];
  blocker?: string;
  composition?: ComposedCallProducts;
}

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const FieldKeySchema = z.string().regex(FIELD_KEY).max(64);
const FieldLabelSchema = z.string().min(1).max(280);
const FieldDescriptionSchema = z.string().min(1).max(280);
const SelectOptionSchema = z.object({ value: z.string().min(1).max(280), label: FieldLabelSchema }).strict();

export const DeploymentComposerFieldSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('artifact'), key: FieldKeySchema, label: FieldLabelSchema,
    description: FieldDescriptionSchema.optional(), required: z.boolean().optional(),
    origins: z.array(z.enum(['repo', 'contract-type'])).min(1).max(2).optional(),
  }).strict(),
  z.object({
    type: z.literal('address'), key: FieldKeySchema, label: FieldLabelSchema,
    description: FieldDescriptionSchema.optional(), required: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('select'), key: FieldKeySchema, label: FieldLabelSchema,
    description: FieldDescriptionSchema.optional(), required: z.boolean().optional(),
    options: z.array(SelectOptionSchema).min(1).max(64),
  }).strict(),
]) satisfies z.ZodType<DeploymentComposerField>;

export const DeploymentTypeParamFieldWireSchema = z.object({
  key: z.string(), label: z.string(), type: z.enum(['string', 'number', 'boolean', 'select']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  required: z.boolean().optional(), description: z.string().optional(),
}) satisfies z.ZodType<DeploymentTypeParamFieldWire>;

export const DeploymentTypeInfoSchema = z.object({
  pluginId: z.string(), pluginVersion: z.string().min(1), label: z.string(), description: z.string(),
  execution: DeploymentTypeExecutionSchema,
  params: z.array(DeploymentTypeParamFieldWireSchema), validateSupported: z.boolean(), composeSupported: z.boolean(),
}) satisfies z.ZodType<DeploymentTypeInfo>;

export const ListDeploymentTypesResponseSchema =
  createApiResponseSchema<ListDeploymentTypesData>('ListDeploymentTypesResponseSchema')(
    z.object({ deploymentTypes: z.array(DeploymentTypeInfoSchema) }),
  );

// Shared package: browser consumers have no Buffer, so UTF-8 byte accounting
// comes from TextEncoder.
const serializedByteLength = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return undefined;
  }
};

// Per-value cap, not just the aggregate one: plugins echo composer values
// back into strings the host bounds tightly (a 1..500-char blocker, a
// 1..280-char label), and an over-cap echo gets the plugin's WHOLE response
// rejected. Capping at the wire boundary is what keeps every plugin author
// from having to defensively truncate host-supplied input. 512 matches the
// derived producer.signature cap, and every legitimate composer value — an
// address, a select value (≤280), a short text — fits well inside it.
const MAX_VALUE_LENGTH = 512;

export const ComposeDeploymentRequestSchema =
  createRequestSchema<ComposeDeploymentRequest>('ComposeDeploymentRequestSchema')(
    z.object({
      pluginId: z.string().min(1).max(128),
      compositionId: z.string().min(1).max(128),
      revision: z.number().int().nonnegative(),
      values: z.record(FieldKeySchema, z.unknown()),
      artifacts: z.record(FieldKeySchema, z.lazy(() => ContractSourceSchema)),
    }).superRefine((request, ctx) => {
      const size = serializedByteLength(request.values);
      if (size === undefined || size > 64 * 1024)
        ctx.addIssue({ code: 'custom', message: 'values must be at most 64 KiB serialized', path: ['values'] });
      if (Object.hasOwn(request.values, 'config'))
        ctx.addIssue({ code: 'custom', message: 'values.config is reserved', path: ['values', 'config'] });
      for (const [key, value] of Object.entries(request.values)) {
        const length = typeof value === 'string' ? value.length : serializedByteLength(value);
        if (length === undefined || length > MAX_VALUE_LENGTH)
          ctx.addIssue({ code: 'custom', message: `each value must be at most ${MAX_VALUE_LENGTH} characters`, path: ['values', key] });
      }
      if (Object.keys(request.artifacts).length > 32)
        ctx.addIssue({ code: 'custom', message: 'at most 32 artifact selections are allowed', path: ['artifacts'] });
    }),
  );

export const ComposedCallProductsSchema = z.object({
  producer: z.object({
    abiArtifactField: FieldKeySchema,
    targetField: FieldKeySchema,
    functionField: FieldKeySchema,
    signature: z.string().min(1).max(512),
    payable: z.boolean(),
  }).strict(),
  products: z.array(z.object({
    key: FieldKeySchema,
    artifactField: FieldKeySchema,
    outputIndex: z.number().int().nonnegative(),
    params: z.record(z.string(), z.unknown()).optional(),
  }).strict()).min(1).max(16),
}).strict() satisfies z.ZodType<ComposedCallProducts>;

export const ComposeDeploymentResponseSchema =
  createApiResponseSchema<ComposeDeploymentData>('ComposeDeploymentResponseSchema')(
    z.object({
      revision: z.number().int().nonnegative(),
      binding: DeploymentTypeBindingSchema,
      fields: z.array(DeploymentComposerFieldSchema).max(32),
      blocker: z.string().min(1).max(500).optional(),
      composition: ComposedCallProductsSchema.optional(),
    }),
  );

export const deploymentTypeRoutes = {
  listDeploymentTypes: {
    method: 'GET' as const,
    path: `${V1_BASE_PATH}/deployment-types`,
    schema: { tags: ['deployments'], response: { 200: ListDeploymentTypesResponseSchema } },
  },
  composeDeployment: {
    method: 'POST' as const,
    path: `${V1_BASE_PATH}/deployment-types/compose`,
    schema: {
      tags: ['deployments'],
      body: ComposeDeploymentRequestSchema,
      response: { 200: ComposeDeploymentResponseSchema },
    },
  },
} as const;
