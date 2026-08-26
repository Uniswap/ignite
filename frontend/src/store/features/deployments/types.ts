import type {
  AckMap,
  ArgValues,
  CallTarget,
  ContractSource,
  DeploymentTypeBinding,
  DeployStep,
  GasOverrides,
  Hex,
  Hex32,
  LibraryBinding,
  ProducedBy,
  RunRecord,
  RunSummary,
  SignerCascade,
  ExternalResolution,
  WorkflowDocument,
  WorkflowOutputs,
  WorkflowRequiredPlugin,
  WorkflowSource,
  ArtifactDriftAcknowledgements,
} from '@ignite/api';

export type DraftContract = ContractSource;

// The wizard keeps the deployment shape close to the shared API contract.
// Later wizard steps can enrich these sparse fields without translating the
// draft on every edit.
// Deploy fields stay on the draft step because the argument and advanced
// editors update them independently. Strategy-specific state lives alongside
// the step in deployExtras so switching a strategy can discard it atomically.
export type DraftDeployStep = Omit<
  DeployStep,
  'strategy' | 'libraries' | 'librariesPerChain'
> & {
  // Wizard-only distinction between an untouched empty initializer and the
  // user's explicit "No initialization" choice. It never reaches the plan.
  initializerSelection?: string;
};

export interface DraftCallStep {
  id: string;
  kind: 'call';
  contractId?: never;
  // A blank target is valid while the wizard is being composed. The API plan
  // assembler omits no such value: Review remains the authoritative guard.
  target: CallTarget | null;
  // References an ABI-bearing contract source in the draft. Set by the
  // composer materializer so a literal (or later overridden) target keeps the
  // authoritative parameter names for editing and encoding.
  abiContractId?: string;
  targetPerChain?: Record<string, CallTarget>;
  signature?: string;
  payable?: boolean;
  args?: ArgValues;
  argsPerChain?: Record<string, Partial<ArgValues>>;
  value?: string;
  valuePerChain?: Record<string, string>;
  gasOverrides?: GasOverrides;
  gasOverridesPerChain?: Record<string, Partial<GasOverrides>>;
  signerOverride?: SignerCascade;
}

export type DraftStep = DraftDeployStep | DraftCallStep;

export interface DraftDeployExtras {
  strategy:
    | { kind: 'create' }
    | { kind: 'create2'; salt?: Hex32; saltPerChain?: Record<string, Hex32> }
    // `producedBy` present means this contract is created by the referenced
    // call step (produced mode): the step submits no transaction of its own
    // and `params` are opaque composition provenance. Absent means the
    // ordinary CREATE2-style plugin strategy.
    | { kind: 'plugin'; pluginId: string; params?: Record<string, unknown>; producedBy?: ProducedBy };
  libraries?: Record<string, LibraryBinding>;
  librariesPerChain?: Record<string, Record<string, LibraryBinding>>;
  prepared?: Record<
    string,
    {
      salt: Hex32;
      predictedAddress: Hex;
      initcodeHash: Hex32;
      notes: string[];
    }
  >;
  acknowledged?: AckMap;
  needsPrepare?: boolean;
}

// The generic deployment composer's draft state: only the composition's
// identity and the user's selections. Server responses (fields, blockers,
// the composed call-products template) are transient — they are refetched by
// re-invoking the compose operation, never persisted, so a restored draft
// cannot replay a stale plugin answer. The call's arguments never live here
// at all: they are filled on the generated call step's card in Steps.
export interface DeploymentCompositionDraft {
  pluginId: string;
  // Recorded from the compose response that materialized the draft. Optional
  // because the composition exists before the first server answer arrives.
  binding?: DeploymentTypeBinding;
  // Minted once when the composer opens so re-applying a composition
  // reconciles the same generated ids instead of accumulating new ones.
  compositionId: string;
  // Composer field values keyed by field key (addresses, selects).
  values: Record<string, unknown>;
  // Artifact-field selections keyed by field key.
  artifacts: Record<string, DraftContract>;
  // Ids this composition generated; recomposition may only replace these.
  ownedContractIds: string[];
  ownedStepIds: string[];
}

export interface DraftRpcSelection {
  endpointId: string;
  label: string;
}

export interface DeployDraftState {
  contracts: DraftContract[];
  chains: number[];
  rpcSelection: Record<string, DraftRpcSelection>;
  explorerSelection: Record<string, string[]>;
  signers: SignerCascade;
  steps: DraftStep[];
  deployExtras: Record<string, DraftDeployExtras>;
  // Ids of contracts added since the wizard was last visited; drives the
  // sidebar badge. A plain count would drift when an unseen contract is
  // removed again before the wizard is opened.
  unseenIds: string[];
  name?: string;
  idempotencyKey?: string;
  workflowRef?: {
    repoPathOrUrl: string;
    name: string;
    baseDocHash: string;
    docHash: string;
  };
  workflowDocument?: WorkflowDocument;
  // Editable source pins are detached from workflowDocument, which remains
  // the immutable loaded/saved baseline for dirty checks.
  workflowSources?: WorkflowSource[];
  workflowIncludedStepIds?: Record<string, boolean>;
  externalResolutions?: ExternalResolution[];
  workflowOutputs?: WorkflowOutputs;
  workflowRequiredPlugins?: WorkflowRequiredPlugin[];
  workflowRunHooks?: string[];
  acknowledgeArtifactDrift?: ArtifactDriftAcknowledgements;
  contractTypeSelectionPending?: boolean;
  composition?: DeploymentCompositionDraft;
}

export type GasOverrideKey = keyof GasOverrides;

export interface SetArgPayload {
  stepId: string;
  key: string;
  value: unknown;
}

export interface SetChainArgOverridePayload extends SetArgPayload {
  chainId: number;
}

export interface RunCursor {
  epoch: string;
  lastSeq: number;
}

export interface DeploymentsState {
  runsById: Record<string, RunRecord>;
  summaries: RunSummary[];
  activeSubscriptions: Record<string, true>;
  backgroundSubscriptions: Record<string, true>;
  epochByRun: Record<string, RunCursor>;
}

export type { ArgValues, GasOverrides };
