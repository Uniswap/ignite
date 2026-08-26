import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  ComposedCallProducts,
  ContractTypeInfo,
  DeploymentTypeBinding,
  Hex,
  Hex32,
  LibraryBinding,
  SignerCascade,
  SignerRef,
  ExternalResolution,
  WorkflowDocument,
} from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import { explorersFetched } from '../explorers/explorersSlice';
import type {
  DraftCallStep,
  DraftDeployExtras,
  DeployDraftState,
  DeploymentCompositionDraft,
  DraftContract,
  DraftStep,
  GasOverrideKey,
  SetArgPayload,
  SetChainArgOverridePayload,
} from './types';
import { cloneJson } from '../../../utils/cloneJson';

const initialState: DeployDraftState = {
  contracts: [],
  chains: [],
  rpcSelection: {},
  explorerSelection: {},
  signers: {},
  steps: [],
  deployExtras: {},
  unseenIds: [],
};

function stepFor(contract: DraftContract) {
  return {
    id: `deploy-${contract.id}`,
    kind: 'deploy' as const,
    contractId: contract.id,
  };
}

function contractNameFromArtifact(sourceIdentifier: string | undefined, fallback: string): string {
  const name = sourceIdentifier?.split(':').at(-1)?.trim();
  return name || fallback;
}

function removeStepAndSource(state: DeployDraftState, stepId: string): void {
  const step = state.steps.find((candidate) => candidate.id === stepId && candidate.kind === 'deploy');
  if (!step) return;
  state.steps = state.steps.filter((candidate) => candidate.id !== stepId);
  state.contracts = state.contracts.filter((contract) => contract.id !== step.contractId);
  delete state.deployExtras[stepId];
  clearDanglingReferences(state, stepId);
}

function removeWrappersFor(state: DeployDraftState, implementationStepId: string): void {
  for (const wrapper of state.steps.filter((step) => step.kind === 'deploy' && step.wraps?.stepId === implementationStepId)) {
    removeStepAndSource(state, wrapper.id);
  }
}

function removeEmptyRecord(
  record: Record<string, unknown> | undefined,
  key: string
): void {
  if (record?.[key] && Object.keys(record[key] as object).length === 0) {
    delete record[key];
  }
}

function deployStep(state: DeployDraftState, stepId: string) {
  const step = state.steps.find(
    (item): item is Extract<DraftStep, { kind: 'deploy' }> =>
      item.id === stepId && item.kind === 'deploy'
  );
  return step;
}

function extrasFor(
  state: DeployDraftState,
  stepId: string
): DraftDeployExtras | undefined {
  if (!deployStep(state, stepId)) return undefined;
  return (state.deployExtras[stepId] ??= { strategy: { kind: 'create' } });
}

function isValueRef(
  value: unknown
): value is { $ref: { kind: 'step'; stepId: string } } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    '$ref' in value &&
    (value as { $ref?: { kind?: string; stepId?: unknown } }).$ref?.kind ===
      'step' &&
    typeof (value as { $ref: { stepId?: unknown } }).$ref.stepId === 'string'
  );
}

function containsReference(value: unknown, stepId: string): boolean {
  if (isValueRef(value)) return value.$ref.stepId === stepId;
  if (Array.isArray(value))
    return value.some((item) => containsReference(item, stepId));
  if (value && typeof value === 'object')
    return Object.values(value).some((item) => containsReference(item, stepId));
  return false;
}

function stepDependsOn(
  step: DraftStep,
  extras: DraftDeployExtras | undefined,
  stepId: string
): boolean {
  if (
    containsReference(step.args, stepId) ||
    containsReference(step.argsPerChain, stepId)
  )
    return true;
  if (step.kind === 'call') {
    return (
      (step.target?.kind === 'step' && step.target.stepId === stepId) ||
      Object.values(step.targetPerChain ?? {}).some(
        (target) => target.kind === 'step' && target.stepId === stepId
      )
    );
  }
  // `producedBy` is the strictest dependency in the draft: a product carries
  // no transaction of its own, so without its producer it cannot be deployed,
  // predicted, or even assembled into a plan. It must be a first-class edge
  // here or every consumer (prediction invalidation, the workflow exclusion
  // warning, dangling-reference cleanup) silently misses it.
  if (
    extras?.strategy.kind === 'plugin' &&
    extras.strategy.producedBy?.stepId === stepId
  )
    return true;
  return (
    Object.values(extras?.libraries ?? {}).some(
      (binding) => binding.kind === 'step' && binding.stepId === stepId
    ) ||
    Object.values(extras?.librariesPerChain ?? {}).some((bindings) =>
      Object.values(bindings).some(
        (binding) => binding.kind === 'step' && binding.stepId === stepId
      )
    )
  );
}

/**
 * The deploy steps `callStepId` produces, in step order. Exported so every
 * surface that must treat a producer call as structural — its own step card,
 * the workflow include label, the removal guard — asks one question instead
 * of re-deriving the `producedBy` scan and drifting from it.
 */
export function producedStepIdsFor(
  state: Pick<DeployDraftState, 'steps' | 'deployExtras'>,
  callStepId: string
): string[] {
  return state.steps.flatMap((step) => {
    if (step.kind !== 'deploy') return [];
    const strategy = state.deployExtras[step.id]?.strategy;
    return strategy?.kind === 'plugin' && strategy.producedBy?.stepId === callStepId
      ? [step.id]
      : [];
  });
}

// A prediction is a property of the complete dependency closure, not merely
// the edited card. Keep the rule in this reducer so every editor path gets the
// same invalidation and acknowledgement behaviour.
function invalidatePredictions(state: DeployDraftState, stepId: string): void {
  const invalidated = new Set<string>();
  const pending = [stepId];
  while (pending.length) {
    const current = pending.pop()!;
    if (invalidated.has(current)) continue;
    invalidated.add(current);
    for (const step of state.steps) {
      if (
        step.kind === 'deploy' &&
        stepDependsOn(step, state.deployExtras[step.id], current)
      ) {
        pending.push(step.id);
      }
    }
  }
  for (const id of invalidated) {
    const extras = state.deployExtras[id];
    if (!extras) continue;
    delete extras.prepared;
    delete extras.acknowledged;
    // Produced-mode plugin steps are never prepared: their addresses come
    // from the producer call, so a re-mine chip would misdescribe them.
    if (extras.strategy.kind === 'plugin' && !extras.strategy.producedBy) extras.needsPrepare = true;
    else delete extras.needsPrepare;
  }
}

function pruneChainPredictions(state: DeployDraftState, chainId: number): void {
  const key = String(chainId);
  for (const extras of Object.values(state.deployExtras)) {
    delete extras.prepared?.[key];
    delete extras.acknowledged?.[key];
    if (extras.prepared && Object.keys(extras.prepared).length === 0) {
      delete extras.prepared;
      if (extras.strategy.kind === 'plugin' && !extras.strategy.producedBy) extras.needsPrepare = true;
    }
    if (extras.acknowledged && Object.keys(extras.acknowledged).length === 0)
      delete extras.acknowledged;
  }
}

function clearDanglingValueRefs(
  value: unknown,
  removedStepId: string
): unknown {
  if (isValueRef(value))
    return value.$ref.stepId === removedStepId ? undefined : value;
  if (Array.isArray(value))
    return value.map((item) => clearDanglingValueRefs(item, removedStepId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(
        ([key, item]) => {
          const next = clearDanglingValueRefs(item, removedStepId);
          return next === undefined ? [] : [[key, next]];
        }
      )
    );
  }
  return value;
}

function clearDanglingReferences(
  state: DeployDraftState,
  removedStepId: string
): void {
  for (const step of state.steps) {
    step.args = clearDanglingValueRefs(
      step.args,
      removedStepId
    ) as typeof step.args;
    step.argsPerChain = clearDanglingValueRefs(
      step.argsPerChain,
      removedStepId
    ) as typeof step.argsPerChain;
    if (step.kind === 'call') {
      if (step.target?.kind === 'step' && step.target.stepId === removedStepId)
        step.target = null;
      for (const [chainId, target] of Object.entries(
        step.targetPerChain ?? {}
      )) {
        if (target.kind === 'step' && target.stepId === removedStepId)
          delete step.targetPerChain?.[chainId];
      }
      if (Object.keys(step.targetPerChain ?? {}).length === 0)
        delete step.targetPerChain;
    }
  }
  for (const extras of Object.values(state.deployExtras)) {
    for (const [name, binding] of Object.entries(extras.libraries ?? {})) {
      if (binding.kind === 'step' && binding.stepId === removedStepId)
        delete extras.libraries?.[name];
    }
    for (const bindings of Object.values(extras.librariesPerChain ?? {})) {
      for (const [name, binding] of Object.entries(bindings)) {
        if (binding.kind === 'step' && binding.stepId === removedStepId)
          delete bindings[name];
      }
    }
  }
  // Fail-safe only: removeCallStep refuses to remove a producer, so a
  // dangling producedBy can arise solely from a bug path. A product without
  // its producer is meaningless — it carries no transaction of its own — so
  // it is removed outright rather than left to fail plan assembly.
  for (const stepId of producedStepIdsFor(state, removedStepId))
    removeStepAndSource(state, stepId);
}

function referencesEncodedContract(
  value: unknown,
  contractIds: Set<string>
): boolean {
  if (!value || typeof value !== 'object') return false;
  const encoded = (value as { $encode?: { contractId?: unknown } }).$encode;
  if (encoded && typeof encoded.contractId === 'string' && contractIds.has(encoded.contractId))
    return true;
  if (Array.isArray(value))
    return value.some((item) => referencesEncodedContract(item, contractIds));
  return Object.values(value).some((item) =>
    referencesEncodedContract(item, contractIds)
  );
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const compositionCallId = (compositionId: string) => `call-${compositionId}`;
const compositionAbiContractId = (compositionId: string) => `${compositionId}:abi`;
// Product keys are plugin-supplied and only charset-checked
// (/^[a-zA-Z][a-zA-Z0-9._-]*$/ server-side), so 'abi' is a legal key: minting
// product ids as `${compositionId}:${key}` put them in the same namespace as
// the host's frozen producer ABI id and let a product named 'abi' take it
// over, pointing the producer call at the wrong ABI. The `product:` segment
// is unforgeable — no key can contain a colon — so host-minted and
// plugin-derived ids can never meet.
const compositionProductContractId = (compositionId: string, key: string) => `${compositionId}:product:${key}`;
const compositionProductStepId = (compositionId: string, key: string) => `deploy-${compositionProductContractId(compositionId, key)}`;

/**
 * Why `applyComposition` would refuse to materialize `composition` into the
 * current draft, or undefined when it can. Exported so the composer screen
 * can surface the reason instead of dispatching a silently ignored action:
 * a reducer cannot answer its caller, and advancing the wizard past a
 * refused materialization would strand the user on a contract-less draft.
 */
export function compositionMaterializationProblem(
  state: DeployDraftState,
  composition: ComposedCallProducts
): string | undefined {
  const draft = state.composition;
  if (!draft) return 'No composition is in progress';
  const { producer, products } = composition;
  if (!draft.artifacts[producer.abiArtifactField])
    return 'Pick the producer contract';
  const address = draft.values[producer.targetField];
  if (typeof address !== 'string' || !ADDRESS.test(address))
    return 'Enter the producer address';
  const unmapped = products.filter((product) => !draft.artifacts[product.artifactField]);
  if (unmapped.length > 0)
    return `Map each produced contract to an artifact: ${unmapped.map((product) => product.key).join(', ')}`;
  // Recomposition may replace only ids this composition owns, and must fail
  // closed — not silently clear the dependency — when a step the user added
  // still points at an owned id that would disappear.
  const keptStepIds = new Set([
    compositionCallId(draft.compositionId),
    ...products.map((product) => compositionProductStepId(draft.compositionId, product.key)),
  ]);
  const removedStepIds = draft.ownedStepIds.filter((id) => !keptStepIds.has(id));
  const keptContractIds = new Set([
    compositionAbiContractId(draft.compositionId),
    ...products.map((product) => compositionProductContractId(draft.compositionId, product.key)),
  ]);
  const removedContractIds = new Set(draft.ownedContractIds.filter((id) => !keptContractIds.has(id)));
  if (removedStepIds.length === 0 && removedContractIds.size === 0) return undefined;
  const owned = new Set(draft.ownedStepIds);
  for (const step of state.steps) {
    if (owned.has(step.id)) continue;
    const removed = removedStepIds.find((id) =>
      stepDependsOn(step, state.deployExtras[step.id], id)
    );
    if (removed) return `Recomposing would remove ${removed}, which ${step.id} still references`;
    if (
      referencesEncodedContract(step.args, removedContractIds) ||
      referencesEncodedContract(step.argsPerChain, removedContractIds)
    )
      return `Recomposing would remove a contract that ${step.id} still encodes against`;
  }
  return undefined;
}

const deployDraftSlice = createSlice({
  name: 'deployDraft',
  initialState,
  reducers: {
    hydrateWorkflowDraft(
      _state,
      action: PayloadAction<{
        repoPathOrUrl: string;
        name: string;
        docHash: string;
        document: WorkflowDocument;
      }>
    ) {
      const { repoPathOrUrl, name, docHash, document } = action.payload;
      const deployExtras: DeployDraftState['deployExtras'] = {};
      const steps: DraftStep[] = document.steps.map((step) => {
        if (step.kind === 'call')
          return {
            ...step,
            target: { ...step.target },
            targetPerChain: step.targetPerChain
              ? { ...step.targetPerChain }
              : undefined,
          } as unknown as DraftStep;
        const { strategy, libraries, librariesPerChain, ...draftStep } = step;
        deployExtras[step.id] = {
          strategy: strategy
            ? ({ ...strategy } as DraftDeployExtras['strategy'])
            : { kind: 'create' },
          ...(libraries ? { libraries: { ...libraries } } : {}),
          ...(librariesPerChain
            ? { librariesPerChain: cloneJson(librariesPerChain) }
            : {}),
          ...(strategy &&
          'acknowledgeDeployed' in strategy &&
          strategy.acknowledgeDeployed
            ? { acknowledged: { ...strategy.acknowledgeDeployed } }
            : {}),
          ...(strategy?.kind === 'plugin' && strategy.prepared
            ? {
                prepared: Object.fromEntries(
                  Object.entries(strategy.prepared).map(
                    ([chainId, prepared]) => [
                      chainId,
                      {
                        ...prepared,
                        salt:
                          strategy.saltPerChain?.[chainId] ??
                          strategy.salt ??
                          (`0x${'0'.repeat(64)}` as Hex32),
                        notes: [],
                      },
                    ]
                  )
                ),
              }
            : {}),
        } as unknown as DraftDeployExtras;
        return draftStep as DraftStep;
      });
      return {
        ...initialState,
        contracts: document.sources.map((source) => {
          if (source.origin === 'contract-type') return {
            id: source.id, origin: 'contract-type' as const, contractName: sanitizeDisplayText(source.contractName),
            pluginId: source.pluginId, artifactKey: source.artifactKey,
            versionLabel: source.versionLabel, contentHash: source.contentHash,
          };
          return {
            id: source.id, repoPathOrUrl: source.repo.url, frameworkId: source.frameworkId,
            artifactPath: source.artifactPath, contractName: sanitizeDisplayText(source.contractName), sourcePath: source.sourcePath, pin: { ...source.repo },
          };
        }),
        chains: [],
        steps,
        deployExtras,
        workflowRef: { repoPathOrUrl, name, baseDocHash: docHash, docHash },
        workflowDocument: cloneJson(document),
        workflowSources: cloneJson(document.sources),
        workflowIncludedStepIds: Object.fromEntries(
          document.steps.map((step) => [step.id, true])
        ),
        externalResolutions: [],
        workflowOutputs: cloneJson(document.outputs),
        workflowRequiredPlugins: cloneJson(document.requiredPlugins),
      };
    },
    toggleWorkflowStep(state, action: PayloadAction<string>) {
      if (
        !state.workflowIncludedStepIds ||
        !(action.payload in state.workflowIncludedStepIds)
      )
        return;
      state.workflowIncludedStepIds[action.payload] =
        !state.workflowIncludedStepIds[action.payload];
      state.externalResolutions = state.externalResolutions?.filter(
        (resolution) => resolution.stepId !== action.payload
      );
    },
    confirmExternalResolution(
      state,
      action: PayloadAction<ExternalResolution>
    ) {
      state.externalResolutions ??= [];
      const index = state.externalResolutions.findIndex(
        (item) =>
          item.stepId === action.payload.stepId &&
          item.path === action.payload.path &&
          item.chainId === action.payload.chainId
      );
      if (index === -1) state.externalResolutions.push(action.payload);
      else state.externalResolutions[index] = action.payload;
    },
    workflowDraftSaved(
      state,
      action: PayloadAction<{ document: WorkflowDocument; docHash: string }>
    ) {
      if (!state.workflowRef) return;
      state.workflowRef.baseDocHash = action.payload.docHash;
      state.workflowRef.docHash = action.payload.docHash;
      state.workflowDocument = cloneJson(action.payload.document);
      state.workflowSources = cloneJson(action.payload.document.sources);
    },
    acceptWorkflowPinUpdate(
      state,
      action: PayloadAction<{
        sourceId: string;
        commit: string;
        ref?: string;
        refKind?: 'tag' | 'branch';
      }>
    ) {
      const source = state.workflowSources?.find(
        (item) => item.id === action.payload.sourceId
      );
      const contract = state.contracts.find(
        (item) => item.id === action.payload.sourceId
      );
      if (!source || !contract) return;
      if (source.origin === 'contract-type' || contract.origin === 'contract-type') return;
      source.repo = {
        url: source.repo.url,
        commit: action.payload.commit,
        ...(action.payload.ref
          ? { ref: action.payload.ref, refKind: action.payload.refKind }
          : {}),
      };
      delete source.artifactHash;
      contract.pin = { ...source.repo };
    },
    setWorkflowRunHooks(state, action: PayloadAction<string[]>) {
      state.workflowRunHooks = [...new Set(action.payload)];
    },
    acknowledgeArtifactDrift(
      state,
      action: PayloadAction<{
        sourceId: string;
        expected: string;
        actual: string;
      }>
    ) {
      state.acknowledgeArtifactDrift ??= {};
      state.acknowledgeArtifactDrift[action.payload.sourceId] = {
        expected: action.payload.expected,
        actual: action.payload.actual,
      };
    },
    seedDraft(_state, action: PayloadAction<DraftContract[]>) {
      return {
        ...initialState,
        contracts: [...action.payload],
        steps: action.payload.map(stepFor),
      };
    },
    addContracts(state, action: PayloadAction<DraftContract[]>) {
      // The first add into an empty draft navigates the user straight into
      // the wizard, so those contracts are seen by definition. Only additions
      // to an already-active draft feed the sidebar badge.
      const wasEmpty = state.contracts.length === 0;
      // Deploying plain contracts abandons an un-materialized composition:
      // otherwise the wizard would show the composer over contracts that are
      // not its products.
      if (wasEmpty) delete state.composition;
      const existing = new Set(state.contracts.map((contract) => contract.id));
      for (const contract of action.payload) {
        if (existing.has(contract.id)) continue;
        existing.add(contract.id);
        state.contracts.push(contract);
        state.steps.push(stepFor(contract));
        if (!wasEmpty) state.unseenIds.push(contract.id);
      }
    },
    removeContract(state, action: PayloadAction<string>) {
      const id = action.payload;
      if (!state.contracts.some((contract) => contract.id === id)) return;
      const removed = state.steps.find(
        (step) => step.kind === 'deploy' && step.contractId === id
      );
      if (removed) removeWrappersFor(state, removed.id);
      if (state.contracts.length === 1) {
        // Removing the last contract ends the session. Chains, signers, name
        // and idempotency key must not silently survive into the next
        // deployment's "first" add.
        return initialState;
      }
      if (removed) {
        invalidatePredictions(state, removed.id);
        removeStepAndSource(state, removed.id);
      }
      state.unseenIds = state.unseenIds.filter((unseen) => unseen !== id);
    },
    markDraftSeen(state) {
      state.unseenIds = [];
    },
    draftLaunched(state, action: PayloadAction<string>) {
      // The launch response can arrive after the user discarded this draft
      // and began composing a new one; only the draft that was actually
      // launched may be cleared.
      if (state.idempotencyKey !== action.payload) return state;
      return initialState;
    },
    moveStep(
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) {
      const { fromIndex, toIndex } = action.payload;
      if (
        fromIndex < 0 ||
        fromIndex >= state.steps.length ||
        toIndex < 0 ||
        toIndex >= state.steps.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const [step] = state.steps.splice(fromIndex, 1);
      state.steps.splice(toIndex, 0, step);
      // A wrapper may have calls between it and its implementation, but may
      // never cross to the preceding side of that implementation.
      if (state.steps.some((candidate, index) => candidate.kind === 'deploy' && candidate.wraps && index <= state.steps.findIndex((item) => item.id === candidate.wraps!.stepId))) {
        state.steps.splice(toIndex, 1);
        state.steps.splice(fromIndex, 0, step);
        return;
      }
      // Likewise a produced product may never precede the call that creates
      // it: producedBy must resolve to an earlier step.
      if (state.steps.some((candidate, index) => {
        if (candidate.kind !== 'deploy') return false;
        const strategy = state.deployExtras[candidate.id]?.strategy;
        return strategy?.kind === 'plugin' && strategy.producedBy !== undefined && index <= state.steps.findIndex((item) => item.id === strategy.producedBy!.stepId);
      })) {
        state.steps.splice(toIndex, 1);
        state.steps.splice(fromIndex, 0, step);
        return;
      }
      // Step order is part of preparation context (and controls which plain
      // creates are resolvable), so a reorder invalidates prepared results.
      for (const item of state.steps) {
        if (item.kind === 'deploy') invalidatePredictions(state, item.id);
      }
    },
    addCallStep: {
      reducer(
        state,
        action: PayloadAction<{ afterIndex: number; id: string }>
      ) {
        const at = Math.max(
          -1,
          Math.min(action.payload.afterIndex, state.steps.length - 1)
        );
        const step: DraftCallStep = {
          id: action.payload.id,
          kind: 'call',
          target: null,
        };
        state.steps.splice(at + 1, 0, step);
      },
      prepare(afterIndex: number) {
        return {
          payload: { afterIndex, id: `call-${globalThis.crypto.randomUUID()}` },
        };
      },
    },
    removeCallStep(state, action: PayloadAction<string>) {
      const index = state.steps.findIndex(
        (step) => step.id === action.payload && step.kind === 'call'
      );
      if (index === -1) return;
      // A producer call cannot be removed from under its products — they
      // carry no transaction of their own. Recomposition is where the
      // generated set is unmade.
      if (producedStepIdsFor(state, action.payload).length > 0) return;
      const [removed] = state.steps.splice(index, 1);
      const affected = state.steps
        .filter(
          (step) =>
            step.kind === 'deploy' &&
            stepDependsOn(step, state.deployExtras[step.id], removed.id)
        )
        .map((step) => step.id);
      clearDanglingReferences(state, removed.id);
      for (const stepId of affected) invalidatePredictions(state, stepId);
    },
    startComposition: {
      reducer(
        state,
        action: PayloadAction<{ pluginId: string; compositionId: string }>
      ) {
        // The entry point is hidden while a draft is active; this guard makes
        // the reducer safe against a stale link regardless. The empty shell
        // this reducer itself mints is deliberately NOT protected: refusing on
        // a composition's mere existence is what let a shell abandoned for one
        // plugin answer another plugin's entry point and render its composer.
        if (state.contracts.length > 0 || compositionInProgress(state.composition))
          return state;
        return {
          ...initialState,
          composition: {
            pluginId: action.payload.pluginId,
            compositionId: action.payload.compositionId,
            values: {},
            artifacts: {},
            ownedContractIds: [],
            ownedStepIds: [],
          },
        };
      },
      prepare(pluginId: string) {
        return {
          payload: { pluginId, compositionId: globalThis.crypto.randomUUID() },
        };
      },
    },
    setCompositionValue(
      state,
      action: PayloadAction<{ key: string; value?: unknown }>
    ) {
      const draft = state.composition;
      if (!draft) return;
      if (action.payload.value === undefined) delete draft.values[action.payload.key];
      else draft.values[action.payload.key] = action.payload.value;
    },
    setCompositionArtifact(
      state,
      action: PayloadAction<{ key: string; source?: DraftContract }>
    ) {
      const draft = state.composition;
      if (!draft) return;
      if (action.payload.source === undefined) delete draft.artifacts[action.payload.key];
      else draft.artifacts[action.payload.key] = action.payload.source;
    },
    // Materializes a complete server-composed call-products template into
    // ordinary draft steps. The server owns field validation; the host owns
    // every generated id (composition-namespaced and deterministic, so a
    // re-apply reconciles rather than accumulates).
    applyComposition(
      state,
      action: PayloadAction<{
        binding: DeploymentTypeBinding;
        composition: ComposedCallProducts;
      }>
    ) {
      const draft = state.composition;
      if (!draft) return;
      const { binding, composition } = action.payload;
      // Fail closed with NO mutation: partial materialization would leave
      // produced contracts silently untracked or user dependencies dangling.
      if (compositionMaterializationProblem(state, composition)) return;
      const { producer, products } = composition;
      const abiContractId = compositionAbiContractId(draft.compositionId);
      const callId = compositionCallId(draft.compositionId);
      const address = draft.values[producer.targetField] as Hex;
      // The selected producer source is frozen under a composition-owned id;
      // the call references it via abiContractId so a literal or later
      // overridden target keeps the authoritative parameter names.
      const abiSource = { ...cloneJson(draft.artifacts[producer.abiArtifactField]), id: abiContractId };
      const abiIndex = state.contracts.findIndex((contract) => contract.id === abiContractId);
      if (abiIndex === -1) state.contracts.push(abiSource);
      else state.contracts[abiIndex] = abiSource;
      const call = state.steps.find(
        (step): step is DraftCallStep => step.id === callId && step.kind === 'call'
      );
      if (!call) {
        // Created argument-less on purpose: the call's arguments are filled
        // on its step card in Steps, where the full editor lives.
        state.steps.unshift({
          id: callId,
          kind: 'call',
          target: { kind: 'address', address },
          signature: producer.signature,
          ...(producer.payable ? { payable: true } : {}),
          abiContractId,
        });
      } else {
        // Re-applying materializes from composer state: the target follows
        // the composer's address field. Argument edits survive only while
        // the function is unchanged — args keyed to the old parameters would
        // silently encode against the new function.
        call.target = { kind: 'address', address };
        call.abiContractId = abiContractId;
        if (call.signature !== producer.signature) {
          call.signature = producer.signature;
          delete call.args;
          delete call.argsPerChain;
        }
        if (producer.payable) call.payable = true;
        else {
          delete call.payable;
          // A call value is only reachable while `payable` is set — the value
          // input and the per-chain overrides render behind it, and a
          // producer's payable flag is the composer's to decide, not the
          // card's. Left behind, the value makes plan assembly emit a call
          // with a value and no payable flag, which CallStepSchema rejects
          // ("call value requires payable: true"), with nothing on screen to
          // edit. Same rule as setWrapperInitializer.
          delete call.value;
          delete call.valuePerChain;
        }
      }
      const desired = products.map((product) => {
        const contractId = compositionProductContractId(draft.compositionId, product.key);
        return {
          contractId,
          stepId: compositionProductStepId(draft.compositionId, product.key),
          source: { ...cloneJson(draft.artifacts[product.artifactField]), id: contractId },
          outputIndex: product.outputIndex,
          params: product.params,
        };
      });
      const desiredByStepId = new Map(desired.map((entry) => [entry.stepId, entry]));
      // Replace only owned generated steps, and keep a product (with the
      // user's constructor declarations) only while it still clones the same
      // artifact — a swapped selection means a different contract.
      for (const stepId of draft.ownedStepIds) {
        if (stepId === callId) continue;
        const wanted = desiredByStepId.get(stepId);
        const existing = wanted && state.contracts.find((contract) => contract.id === wanted.contractId);
        if (wanted && existing && JSON.stringify(existing) === JSON.stringify(wanted.source)) continue;
        invalidatePredictions(state, stepId);
        removeStepAndSource(state, stepId);
      }
      const staleContractIds = new Set(
        draft.ownedContractIds.filter(
          (id) => id !== abiContractId && !desired.some((entry) => entry.contractId === id)
        )
      );
      state.contracts = state.contracts.filter((contract) => !staleContractIds.has(contract.id));
      const callIndex = state.steps.findIndex((step) => step.id === callId);
      for (const entry of desired) {
        if (!state.contracts.some((contract) => contract.id === entry.contractId)) {
          state.contracts.push(entry.source);
        }
        if (!state.steps.some((step) => step.id === entry.stepId)) {
          // Insert after the call and the products already in place so a
          // fresh materialization lists products in declared product order.
          let at = callIndex;
          while (at + 1 < state.steps.length) {
            const next = state.steps[at + 1];
            const strategy =
              next.kind === 'deploy'
                ? state.deployExtras[next.id]?.strategy
                : undefined;
            if (strategy?.kind === 'plugin' && strategy.producedBy?.stepId === callId) at += 1;
            else break;
          }
          state.steps.splice(at + 1, 0, {
            id: entry.stepId,
            kind: 'deploy',
            contractId: entry.contractId,
          });
        }
        const strategy: DraftDeployExtras['strategy'] = {
          kind: 'plugin',
          pluginId: draft.pluginId,
          ...(entry.params ? { params: cloneJson(entry.params) } : {}),
          producedBy: { stepId: callId, outputIndex: entry.outputIndex },
        };
        const current = state.deployExtras[entry.stepId]?.strategy;
        // A changed output index or params means a different produced
        // address: dependents' predictions are stale.
        if (current && JSON.stringify(current) !== JSON.stringify(strategy)) {
          invalidatePredictions(state, entry.stepId);
        }
        state.deployExtras[entry.stepId] = { strategy };
      }
      // Materialization happens inside the open wizard, so unlike
      // addContracts it marks nothing unseen: the user is looking at it.
      draft.binding = cloneJson(binding);
      draft.ownedContractIds = [abiContractId, ...desired.map((entry) => entry.contractId)];
      draft.ownedStepIds = [callId, ...desired.map((entry) => entry.stepId)];
    },
    clearComposition(state) {
      delete state.composition;
    },
    toggleChain(state, action: PayloadAction<number>) {
      const chainId = action.payload;
      const index = state.chains.indexOf(chainId);
      if (index === -1) {
        state.chains.push(chainId);
        return;
      }
      state.chains.splice(index, 1);
      const key = String(chainId);
      delete state.rpcSelection[key];
      delete state.explorerSelection[key];
      delete state.signers.perChain?.[key];
      for (const step of state.steps) {
        delete step.argsPerChain?.[key];
        delete step.valuePerChain?.[key];
        delete step.gasOverridesPerChain?.[key];
        delete step.signerOverride?.perChain?.[key];
        if (Object.keys(step.signerOverride?.perChain ?? {}).length === 0) {
          delete step.signerOverride?.perChain;
        }
        if (!step.signerOverride?.global && !step.signerOverride?.perChain) {
          step.signerOverride = undefined;
        }
      }
      for (const extras of Object.values(state.deployExtras)) {
        if (extras.strategy.kind === 'create2')
          delete extras.strategy.saltPerChain?.[key];
        delete extras.librariesPerChain?.[key];
      }
      pruneChainPredictions(state, chainId);
    },
    selectRpc(
      state,
      action: PayloadAction<{
        chainId: number;
        endpointId: string;
        label: string;
      }>
    ) {
      const { chainId, endpointId, label } = action.payload;
      state.rpcSelection[String(chainId)] = { endpointId, label };
    },
    setExplorerSelection(
      state,
      action: PayloadAction<Record<string, string[]>>
    ) {
      state.explorerSelection = action.payload;
    },
    setGlobalSigner(state, action: PayloadAction<SignerRef | undefined>) {
      state.signers.global = action.payload;
    },
    setChainSigner(
      state,
      action: PayloadAction<{ chainId: number; signer?: SignerRef }>
    ) {
      const key = String(action.payload.chainId);
      if (action.payload.signer === undefined) {
        delete state.signers.perChain?.[key];
        if (Object.keys(state.signers.perChain ?? {}).length === 0) {
          delete state.signers.perChain;
        }
        return;
      }
      state.signers.perChain ??= {};
      state.signers.perChain[key] = action.payload.signer;
    },
    setArg(state, action: PayloadAction<SetArgPayload>) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      step.args ??= {};
      step.args[action.payload.key] = action.payload.value;
      if (step.kind === 'deploy') invalidatePredictions(state, step.id);
    },
    setContractTypeSelectionPending(state, action: PayloadAction<boolean>) {
      state.contractTypeSelectionPending = action.payload || undefined;
    },
    refreshContractTypeSource(state, action: PayloadAction<{ sourceId: string; versionLabel: string; contentHash: string }>) {
      const source = state.contracts.find((item) => item.id === action.payload.sourceId);
      if (!source || source.origin !== 'contract-type') return;
      source.versionLabel = action.payload.versionLabel;
      source.contentHash = action.payload.contentHash;
      const workflowSource = state.workflowSources?.find((item) => item.id === source.id);
      if (workflowSource?.origin === 'contract-type') {
        workflowSource.versionLabel = action.payload.versionLabel;
        workflowSource.contentHash = action.payload.contentHash;
      }
      const wrapper = state.steps.find((item) => item.kind === 'deploy' && item.contractId === source.id);
      if (wrapper) invalidatePredictions(state, wrapper.id);
    },
    setChainArgOverride(
      state,
      action: PayloadAction<SetChainArgOverridePayload>
    ) {
      const { stepId, chainId, key, value } = action.payload;
      const step = state.steps.find(({ id }) => id === stepId);
      if (!step) return;
      const chainKey = String(chainId);
      if (value === undefined) {
        delete step.argsPerChain?.[chainKey]?.[key];
        removeEmptyRecord(step.argsPerChain, chainKey);
        if (Object.keys(step.argsPerChain ?? {}).length === 0) {
          delete step.argsPerChain;
        }
        if (step.kind === 'deploy') invalidatePredictions(state, step.id);
        return;
      }
      step.argsPerChain ??= {};
      step.argsPerChain[chainKey] ??= {};
      step.argsPerChain[chainKey][key] = value;
      if (step.kind === 'deploy') invalidatePredictions(state, step.id);
    },
    selectContractType(
      state,
      action: PayloadAction<{
        implementationStepId: string;
        contractType?: ContractTypeInfo;
        artifact?: { sourceIdentifier?: string };
      }>
    ) {
      const impl = deployStep(state, action.payload.implementationStepId);
      if (!impl) return;
      removeWrappersFor(state, impl.id);
      const type = action.payload.contractType;
      const synthesis = type?.synthesis;
      if (!type || !synthesis) {
        invalidatePredictions(state, impl.id);
        return;
      }
      const sourceId = `contract-type-${globalThis.crypto.randomUUID()}`;
      const wrapperId = `deploy-${sourceId}`;
      const source: DraftContract = {
        id: sourceId,
        origin: 'contract-type',
        contractName: contractNameFromArtifact(action.payload.artifact?.sourceIdentifier, synthesis.artifact),
        pluginId: type.pluginId,
        artifactKey: synthesis.artifact,
        versionLabel: type.versionLabel,
        contentHash: type.contentHash,
      };
      const args: Record<string, unknown> = {};
      for (const arg of synthesis.constructorArgs) {
        if (arg.from === 'implementation') args[arg.name] = { $ref: { kind: 'step', stepId: impl.id } };
        else if (arg.from === 'initializer') args[arg.name] = '0x';
      }
      const wrapper = {
        id: wrapperId,
        kind: 'deploy' as const,
        contractId: sourceId,
        wraps: { stepId: impl.id, contractTypePluginId: type.pluginId },
        args,
      };
      state.contracts.push(source);
      const index = state.steps.findIndex((step) => step.id === impl.id);
      state.steps.splice(index + 1, 0, wrapper);
      state.deployExtras[wrapperId] = { strategy: { kind: 'create' } };
      invalidatePredictions(state, wrapperId);
    },
    setAcknowledgeUninitialized(
      state,
      action: PayloadAction<{ stepId: string; acknowledged: boolean }>
    ) {
      const step = deployStep(state, action.payload.stepId);
      if (!step?.wraps) return;
      if (action.payload.acknowledged) step.acknowledgeUninitialized = true;
      else delete step.acknowledgeUninitialized;
    },
    setAcknowledgeUnverifiedBytecode(
      state,
      action: PayloadAction<{ stepId: string; acknowledged: boolean }>
    ) {
      const step = deployStep(state, action.payload.stepId);
      if (!step?.wraps) return;
      if (action.payload.acknowledged) step.acknowledgeUnverifiedBytecode = true;
      else delete step.acknowledgeUnverifiedBytecode;
    },
    setWrapperInitializer(
      state,
      action: PayloadAction<{ stepId: string; key: string; value: unknown; selection: string; payable?: boolean }>
    ) {
      const step = deployStep(state, action.payload.stepId);
      if (!step?.wraps) return;
      step.args ??= {};
      step.args[action.payload.key] = action.payload.value;
      // Per-chain initializer overrides are complete, atomic values. A global
      // function switch must not retain an override for the prior function.
      for (const [chainId, args] of Object.entries(step.argsPerChain ?? {})) {
        delete args[action.payload.key];
        removeEmptyRecord(step.argsPerChain, chainId);
      }
      if (Object.keys(step.argsPerChain ?? {}).length === 0) delete step.argsPerChain;
      if (!action.payload.payable) {
        delete step.value;
        delete step.valuePerChain;
      }
      step.initializerSelection = action.payload.selection;
      invalidatePredictions(state, step.id);
    },
    setValue(state, action: PayloadAction<{ stepId: string; value?: string }>) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      step.value = action.payload.value;
    },
    setValuePerChain(
      state,
      action: PayloadAction<{ stepId: string; chainId: number; value?: string }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      const key = String(action.payload.chainId);
      if (action.payload.value === undefined) {
        delete step.valuePerChain?.[key];
        if (Object.keys(step.valuePerChain ?? {}).length === 0)
          delete step.valuePerChain;
        return;
      }
      step.valuePerChain ??= {};
      step.valuePerChain[key] = action.payload.value;
    },
    setGasOverride(
      state,
      action: PayloadAction<{
        stepId: string;
        key: GasOverrideKey;
        value?: string;
      }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      if (action.payload.value === undefined) {
        delete step.gasOverrides?.[action.payload.key];
        if (Object.keys(step.gasOverrides ?? {}).length === 0) {
          delete step.gasOverrides;
        }
        return;
      }
      step.gasOverrides ??= {};
      step.gasOverrides[action.payload.key] = action.payload.value;
    },
    setGasOverridePerChain(
      state,
      action: PayloadAction<{
        stepId: string;
        chainId: number;
        key: GasOverrideKey;
        value?: string;
      }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (!step) return;
      const chainKey = String(action.payload.chainId);
      if (action.payload.value === undefined) {
        delete step.gasOverridesPerChain?.[chainKey]?.[action.payload.key];
        removeEmptyRecord(step.gasOverridesPerChain, chainKey);
        if (Object.keys(step.gasOverridesPerChain ?? {}).length === 0) {
          delete step.gasOverridesPerChain;
        }
        return;
      }
      step.gasOverridesPerChain ??= {};
      step.gasOverridesPerChain[chainKey] ??= {};
      step.gasOverridesPerChain[chainKey][action.payload.key] =
        action.payload.value;
    },
    setCallStepField(
      state,
      action: PayloadAction<{
        id: string;
        patch: Partial<Omit<DraftCallStep, 'id' | 'kind'>>;
      }>
    ) {
      const step = state.steps.find(
        (item): item is DraftCallStep =>
          item.id === action.payload.id && item.kind === 'call'
      );
      if (!step) return;
      Object.assign(step, action.payload.patch);
    },
    setStrategy(
      state,
      action: PayloadAction<{
        stepId: string;
        strategy: DraftDeployExtras['strategy'];
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      // A strategy kind owns all prepare/ack/salt state. Do not let a
      // Create2 commitment leak into a plugin (or vice versa).
      if (extras.strategy.kind !== action.payload.strategy.kind) {
        delete extras.prepared;
        delete extras.acknowledged;
        delete extras.needsPrepare;
      }
      extras.strategy = action.payload.strategy;
      if (extras.strategy.kind === 'plugin') extras.needsPrepare = true;
      invalidatePredictions(state, action.payload.stepId);
    },
    setSalt(state, action: PayloadAction<{ stepId: string; salt?: Hex32 }>) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'create2') return;
      extras.strategy.salt = action.payload.salt;
      invalidatePredictions(state, action.payload.stepId);
    },
    setSaltPerChain(
      state,
      action: PayloadAction<{ stepId: string; chainId: number; salt?: Hex32 }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'create2') return;
      const key = String(action.payload.chainId);
      if (action.payload.salt === undefined) {
        delete extras.strategy.saltPerChain?.[key];
        if (Object.keys(extras.strategy.saltPerChain ?? {}).length === 0)
          delete extras.strategy.saltPerChain;
      } else {
        extras.strategy.saltPerChain ??= {};
        extras.strategy.saltPerChain[key] = action.payload.salt;
      }
      invalidatePredictions(state, action.payload.stepId);
    },
    setLibraries(
      state,
      action: PayloadAction<{
        stepId: string;
        libraries?: Record<string, LibraryBinding>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.libraries = action.payload.libraries;
      invalidatePredictions(state, action.payload.stepId);
    },
    setLibrariesPerChain(
      state,
      action: PayloadAction<{
        stepId: string;
        librariesPerChain?: Record<string, Record<string, LibraryBinding>>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.librariesPerChain = action.payload.librariesPerChain;
      invalidatePredictions(state, action.payload.stepId);
    },
    setPluginParams(
      state,
      action: PayloadAction<{
        stepId: string;
        params?: Record<string, unknown>;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras || extras.strategy.kind !== 'plugin') return;
      extras.strategy.params = action.payload.params;
      invalidatePredictions(state, action.payload.stepId);
    },
    storePrepared(
      state,
      action: PayloadAction<{
        stepId: string;
        chains: Record<
          string,
          {
            salt: Hex32;
            predictedAddress: Hex;
            initcodeHash: Hex32;
            notes: string[];
          }
        >;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.prepared = action.payload.chains;
      delete extras.needsPrepare;
    },
    acknowledgeDeployed(
      state,
      action: PayloadAction<{
        stepId: string;
        chainId: number;
        predictedAddress: Hex;
        initcodeHash: Hex32;
      }>
    ) {
      const extras = extrasFor(state, action.payload.stepId);
      if (!extras) return;
      extras.acknowledged ??= {};
      extras.acknowledged[String(action.payload.chainId)] = {
        predictedAddress: action.payload.predictedAddress,
        initcodeHash: action.payload.initcodeHash,
      };
    },
    setStepSigner(
      state,
      action: PayloadAction<{ stepId: string; cascade?: SignerCascade }>
    ) {
      const step = state.steps.find(({ id }) => id === action.payload.stepId);
      if (step) step.signerOverride = action.payload.cascade;
    },
    setName(state, action: PayloadAction<string | undefined>) {
      state.name = action.payload;
    },
    mintIdempotencyKey: {
      reducer(state, action: PayloadAction<string>) {
        state.idempotencyKey ??= action.payload;
      },
      prepare() {
        return { payload: globalThis.crypto.randomUUID() };
      },
    },
    clearDraft() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    // The draft keeps its own copy of the selection and is persisted across
    // reloads, so a rotated chain-sourced id outlives the entry it named. It
    // renders no checkbox to clear it and fails validation with
    // EXPLORER_NOT_FOUND, which leaves review permanently unable to launch, so
    // it is dropped as soon as the server states which entries exist.
    builder.addCase(explorersFetched, (state, action) => {
      const key = String(action.payload.chainId);
      const selected = state.explorerSelection[key];
      if (!selected) return;
      const available = new Set(
        action.payload.data.entries.map((entry) => entry.id)
      );
      state.explorerSelection[key] = selected.filter((id) => available.has(id));
    });
  },
});

export const {
  hydrateWorkflowDraft,
  toggleWorkflowStep,
  confirmExternalResolution,
  workflowDraftSaved,
  acceptWorkflowPinUpdate,
  setWorkflowRunHooks,
  acknowledgeArtifactDrift,
  seedDraft,
  addContracts,
  removeContract,
  markDraftSeen,
  draftLaunched,
  moveStep,
  addCallStep,
  removeCallStep,
  startComposition,
  setCompositionValue,
  setCompositionArtifact,
  applyComposition,
  clearComposition,
  toggleChain,
  selectRpc,
  setExplorerSelection,
  setGlobalSigner,
  setChainSigner,
  setArg,
  setContractTypeSelectionPending,
  refreshContractTypeSource,
  setChainArgOverride,
  selectContractType,
  setAcknowledgeUninitialized,
  setAcknowledgeUnverifiedBytecode,
  setWrapperInitializer,
  setValue,
  setValuePerChain,
  setGasOverride,
  setGasOverridePerChain,
  setCallStepField,
  setStrategy,
  setSalt,
  setSaltPerChain,
  setLibraries,
  setLibrariesPerChain,
  setPluginParams,
  storePrepared,
  acknowledgeDeployed,
  setStepSigner,
  setName,
  mintIdempotencyKey,
  clearDraft,
} = deployDraftSlice.actions;

export const deployDraftReducer = deployDraftSlice.reducer;
export { initialState as deployDraftInitialState };

/**
 * Whether a composition holds work worth resuming. `startComposition` mints
 * a draft carrying nothing but ids the moment the composer opens, so merely
 * visiting the composer and backing out leaves a truthy but empty draft
 * behind. Anything gating an entry point on "a session is in progress" must
 * ask this instead of testing `composition` for existence: treating the empty
 * shell as a session left the Deployments header offering only "Manage
 * deployment → composer" with no route back to a plain deployment.
 *
 * Inside the wizard the plain existence check is still correct: an empty
 * composition is exactly what the composer station exists to fill in.
 */
export function compositionInProgress(
  composition: DeploymentCompositionDraft | undefined
): boolean {
  if (!composition) return false;
  // Empty strings are excluded deliberately: a half-typed-then-cleared
  // address field must not count as meaningful work on its own.
  return Boolean(
    Object.values(composition.values).some((value) => value !== undefined && value !== '') ||
      Object.keys(composition.artifacts).length > 0 ||
      composition.ownedStepIds.length > 0
  );
}

export function workflowDependentsForExclusion(
  state: DeployDraftState,
  stepId: string
): string[] {
  const affected = new Set<string>();
  const pending = [stepId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const step of state.steps) {
      if (step.id === stepId || affected.has(step.id)) continue;
      if (stepDependsOn(step, state.deployExtras[step.id], current)) {
        affected.add(step.id);
        pending.push(step.id);
      }
    }
  }
  return [...affected];
}

export function ackStale(
  state: DeployDraftState,
  stepId: string,
  chainId: number
): boolean {
  const extras = state.deployExtras[stepId];
  const acknowledgement = extras?.acknowledged?.[String(chainId)];
  const prepared = extras?.prepared?.[String(chainId)];
  return Boolean(
    acknowledgement &&
    (!prepared ||
      acknowledgement.predictedAddress !== prepared.predictedAddress ||
      acknowledgement.initcodeHash !== prepared.initcodeHash)
  );
}
