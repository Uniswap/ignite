import { z } from 'zod';
import {
  ContractSourceSchema,
  DeploymentTypeBindingSchema,
  Hex32Schema,
  SignerCascadeSchema,
  ExternalResolutionSchema,
  makeWorkflowDocumentSchema,
} from '@ignite/api';
import type { DeployDraftState } from './types';

export const DEPLOY_DRAFT_STORAGE_KEY = 'ignite.deployDraft.v3';
// v1 cannot express calls or strategy state; v2 predates the produced-mode
// migration and carried since-removed first-class strategy shapes. Both are
// deliberately stale sessions.
const LEGACY_DEPLOY_DRAFT_STORAGE_KEYS = [
  'ignite.deployDraft.v1',
  'ignite.deployDraft.v2',
];

// TypeScript types cannot validate parsed JSON: restored drafts are checked
// against this schema plus the cross-field invariants below, and anything
// suspect falls back to an empty draft. Bump the storage key version on
// breaking shape changes instead of writing migrations.
const GasOverridesDraftSchema = z.object({
  gasLimit: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
});

// Every address, salt and amount field in the wizard writes each keystroke
// straight into the draft, and the store persists synchronously on change, so
// a draft in storage routinely holds text that is not yet a value — including
// the '0x' sentinel the target and library inputs write for a cleared field.
// Parsing those with the plan-level schemas (strict addresses, Hex32) threw on
// restore, and a throw here discards the WHOLE draft: composition, contracts,
// chains, signers and args, for one half-typed character. Amounts (`value`,
// gas overrides) were already tolerated as plain strings for exactly this
// reason; these fields now follow the same rule. Nothing is loosened for the
// plan itself — a partial address or salt still fails validation and blocks
// launch, it just no longer destroys the session on reload.
const DraftHexTextSchema = z.string();
const DraftCallTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), stepId: z.string().min(1) }),
  z.object({ kind: z.literal('address'), address: DraftHexTextSchema }),
]);
const DraftLibraryBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('address'), address: DraftHexTextSchema }),
  z.object({ kind: z.literal('step'), stepId: z.string().min(1) }),
]);

const DraftDeployStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('deploy'),
  contractId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  argsPerChain: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  value: z.string().optional(),
  valuePerChain: z.record(z.string(), z.string()).optional(),
  gasOverrides: GasOverridesDraftSchema.optional(),
  gasOverridesPerChain: z
    .record(z.string(), GasOverridesDraftSchema.partial())
    .optional(),
  signerOverride: SignerCascadeSchema.optional(),
  wraps: z
    .object({ stepId: z.string().min(1), contractTypePluginId: z.string().min(1) })
    .optional(),
  acknowledgeUninitialized: z.literal(true).optional(),
  acknowledgeUnverifiedBytecode: z.literal(true).optional(),
  initializerSelection: z.string().optional(),
});

const DraftCallStepSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('call'),
  target: DraftCallTargetSchema.nullable(),
  abiContractId: z.string().min(1).optional(),
  targetPerChain: z.record(z.string(), DraftCallTargetSchema).optional(),
  signature: z.string().optional(),
  payable: z.boolean().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  argsPerChain: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  value: z.string().optional(),
  valuePerChain: z.record(z.string(), z.string()).optional(),
  gasOverrides: GasOverridesDraftSchema.optional(),
  gasOverridesPerChain: z
    .record(z.string(), GasOverridesDraftSchema.partial())
    .optional(),
  signerOverride: SignerCascadeSchema.optional(),
});

const DraftDeployExtrasSchema = z.object({
  strategy: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create') }),
    z.object({
      kind: z.literal('create2'),
      salt: DraftHexTextSchema.optional(),
      saltPerChain: z.record(z.string(), DraftHexTextSchema).optional(),
    }),
    z.object({
      kind: z.literal('plugin'),
      pluginId: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      producedBy: z
        .object({
          stepId: z.string().min(1),
          outputIndex: z.number().int().nonnegative(),
        })
        .optional(),
    }),
  ]),
  libraries: z.record(z.string(), DraftLibraryBindingSchema).optional(),
  librariesPerChain: z
    .record(z.string(), z.record(z.string(), DraftLibraryBindingSchema))
    .optional(),
  // Prepared and acknowledged values are server answers, never typed: they
  // stay strict so a corrupted prediction is dropped rather than trusted.
  prepared: z
    .record(
      z.string(),
      z.object({
        salt: Hex32Schema,
        predictedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        initcodeHash: Hex32Schema,
        notes: z.array(z.string()),
      })
    )
    .optional(),
  acknowledged: z
    .record(
      z.string(),
      z.object({
        predictedAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        initcodeHash: Hex32Schema,
      })
    )
    .optional(),
  needsPrepare: z.boolean().optional(),
});

const PersistedDraftSchema = z.object({
  contracts: z.array(ContractSourceSchema),
  chains: z.array(z.number()),
  rpcSelection: z.record(
    z.string(),
    z.object({ endpointId: z.string(), label: z.string() })
  ),
  explorerSelection: z.record(z.string(), z.array(z.string())),
  signers: SignerCascadeSchema,
  steps: z.array(
    z.discriminatedUnion('kind', [DraftDeployStepSchema, DraftCallStepSchema])
  ),
  deployExtras: z.record(z.string(), DraftDeployExtrasSchema),
  unseenIds: z.array(z.string()),
  name: z.string().optional(),
  idempotencyKey: z.string().optional(),
  workflowRef: z
    .object({
      repoPathOrUrl: z.string(),
      name: z.string(),
      baseDocHash: z.string(),
      docHash: z.string(),
    })
    .optional(),
  workflowDocument: makeWorkflowDocumentSchema({
    allowFileUrls: true,
  }).optional(),
  workflowSources: z.array(z.unknown()).optional(),
  workflowIncludedStepIds: z.record(z.string(), z.boolean()).optional(),
  externalResolutions: z.array(ExternalResolutionSchema).optional(),
  workflowOutputs: z.object({ hooks: z.array(z.string()) }).optional(),
  workflowRequiredPlugins: z
    .array(
      z.object({
        id: z.string(),
        version: z.string(),
        source: z.unknown().optional(),
      })
    )
    .optional(),
  workflowRunHooks: z.array(z.string()).optional(),
  acknowledgeArtifactDrift: z
    .record(z.string(), z.object({ expected: z.string(), actual: z.string() }))
    .optional(),
  // Only the composition's identity and selections persist. Server responses
  // (fields, blockers, composed templates) are refetched on restore, so a
  // reload can never replay a stale plugin answer.
  composition: z
    .object({
      pluginId: z.string().min(1),
      binding: DeploymentTypeBindingSchema.optional(),
      compositionId: z.string().min(1),
      values: z.record(z.string(), z.unknown()),
      artifacts: z.record(z.string(), ContractSourceSchema),
      ownedContractIds: z.array(z.string().min(1)),
      ownedStepIds: z.array(z.string().min(1)),
    })
    .optional(),
});

function invariantsHold(draft: DeployDraftState): boolean {
  // No contracts means no session: restoring chains/signers/name without
  // contracts would let dormant configuration leak into the next deployment.
  // An in-progress composition is the deliberate exception — the spec
  // requires restoring an incomplete composer session, and it cannot smuggle
  // dormant configuration because startComposition resets the draft and the
  // wizard only reaches the chains/signers stations after materialization
  // creates contracts.
  if (draft.contracts.length === 0 && !draft.composition) return false;
  const contractIds = new Set(draft.contracts.map((contract) => contract.id));
  if (contractIds.size !== draft.contracts.length) return false;
  const deploySteps = draft.steps.filter((step) => step.kind === 'deploy');
  const stepContractIds = new Set(deploySteps.map((step) => step.contractId));
  if (!draft.workflowRef && stepContractIds.size !== deploySteps.length)
    return false;
  // Outside workflow mode every contract pairs 1:1 with a deploy step,
  // except composition-owned sources: the frozen producer ABI source is a
  // contract that is deliberately never deployed.
  if (!draft.workflowRef) {
    const owned = new Set(draft.composition?.ownedContractIds ?? []);
    const deployless = draft.contracts.filter(
      (contract) => !stepContractIds.has(contract.id)
    );
    if (deployless.some((contract) => !owned.has(contract.id))) return false;
    if (deploySteps.length !== draft.contracts.length - deployless.length)
      return false;
  }
  const stepIds = new Set(draft.steps.map((step) => step.id));
  if (stepIds.size !== draft.steps.length) return false;
  for (const step of deploySteps)
    if (!contractIds.has(step.contractId)) return false;
  for (const step of deploySteps) {
    if (!step.wraps) continue;
    const implIndex = draft.steps.findIndex((candidate) => candidate.id === step.wraps!.stepId);
    if (implIndex < 0 || draft.steps.findIndex((candidate) => candidate.id === step.id) <= implIndex)
      return false;
  }
  if (!draft.unseenIds.every((id) => contractIds.has(id))) return false;
  return Object.keys(draft.deployExtras).every((id) =>
    deploySteps.some((step) => step.id === id)
  );
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem'>>;

function defaultStorage(): DraftStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(
  storage: DraftStorage | undefined = defaultStorage()
): DeployDraftState | undefined {
  try {
    // Older keys are deliberately stale sessions: remove them so a later
    // reload cannot resurrect one.
    for (const key of LEGACY_DEPLOY_DRAFT_STORAGE_KEYS) {
      if (storage?.getItem(key)) storage.removeItem?.(key);
    }
    const raw = storage?.getItem(DEPLOY_DRAFT_STORAGE_KEY);
    if (!raw) return undefined;
    const value = PersistedDraftSchema.parse(JSON.parse(raw));
    if (value.workflowSources && value.workflowDocument)
      makeWorkflowDocumentSchema({ allowFileUrls: true }).parse({ ...value.workflowDocument, sources: value.workflowSources });
    const parsed = value as DeployDraftState;
    if (!invariantsHold(parsed)) return undefined;
    // Prepared plugin initcode is intentionally not trusted across reloads.
    for (const extras of Object.values(parsed.deployExtras)) {
      if (extras.strategy.kind === 'plugin' && extras.prepared)
        extras.needsPrepare = true;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveDraft(
  draft: DeployDraftState,
  storage: DraftStorage | undefined = defaultStorage()
): void {
  try {
    storage?.setItem(DEPLOY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the draft simply does not persist.
  }
}
