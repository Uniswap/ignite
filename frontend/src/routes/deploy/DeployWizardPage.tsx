import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Save, Trash2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import { useEnsureChainMetadata } from '../../store/features/chains/useEnsureChainMetadata';
import {
  markDraftSeen,
  clearDraft,
  removeContract,
  hydrateWorkflowDraft,
  startComposition,
  applyComposition,
  compositionInProgress,
  compositionMaterializationProblem,
} from '../../store/features/deployments/deployDraftSlice';
import type { DeployDraftState } from '../../store/features/deployments/types';
import ConfirmDialog from '../../components/ConfirmDialog';
import WizardStepper from './components/WizardStepper';
import ContractsStep from './steps/ContractsStep';
import ComposerStep from './steps/ComposerStep';
import {
  composerRequiredBlocker,
  useDeploymentComposer,
} from './useDeploymentComposer';
import { apiClient } from '../../store/api/client';
import { sanitizeDisplayText, type DeploymentTypeInfo } from '@ignite/api';
import ChainsStep from './steps/ChainsStep';
import ExplorersStep from './steps/ExplorersStep';
import SignersStep from './steps/SignersStep';
import StepsStep from './steps/StepsStep';
import ReviewStep from './steps/ReviewStep';
import { planFromDraft } from './planFromDraft';
import type { ExplorerEntry } from '@ignite/api';
import { replaceIdsForDisplay } from '../../utils/displayText';
import { workflowsApi } from '../../store/features/workflows/workflowsApi';
import { selectWorkflowDocument } from '../../store/features/workflows/workflowsSlice';
import {
  workflowDocumentFromDraft,
} from '../../store/features/deployments/workflowDraft';
import { collectUnboundWorkflowSlots, projectWorkflowPlan } from './projection';
import { cloneJson } from '../../utils/cloneJson';
import PromoteWorkflowDialog from '../../components/PromoteWorkflowDialog';
import { triggerToast } from '../../store/middleware/toastListener';
import { useDeploymentArtifacts } from './useDeploymentArtifacts';
import { useValidationReport } from './useValidationReport';

const STEPS = [
  { id: 'contracts', label: 'Contracts' },
  { id: 'chains', label: 'Chains & RPCs' },
  { id: 'explorers', label: 'Explorers' },
  { id: 'signers', label: 'Signers' },
  { id: 'steps', label: 'Steps' },
  { id: 'review', label: 'Review' },
];

/**
 * What entering /deploy should do about the composer, if anything. The URL's
 * deployment type and the draft composition's plugin must never disagree: the
 * wizard renders whatever `draft.composition.pluginId` says, so a leftover
 * shell for one plugin answering another plugin's entry point materializes a
 * deployment of the wrong deployment type. Meaningful work is the pivot — an
 * empty shell (minted the moment the composer opens) is replaceable, a
 * composition holding selections or materialized steps is never discarded
 * behind the user's back.
 */
export function composerEntryAction(
  deploymentType: string | null,
  draft: Pick<DeployDraftState, 'contracts' | 'composition' | 'workflowRef'>
): 'start' | 'clear' | 'conflict' | 'none' {
  const composition = draft.composition;
  const meaningful =
    Boolean(composition) &&
    (compositionInProgress(composition) || draft.contracts.length > 0);
  if (deploymentType) {
    // The requested type is already the one being composed: resume it.
    if (composition?.pluginId === deploymentType) return 'none';
    if (meaningful) return 'conflict';
    return draft.contracts.length === 0 && !draft.workflowRef ? 'start' : 'none';
  }
  // Backing out of the composer before materialization must not leave "New
  // deployment" opening onto the composer station.
  if (composition && !meaningful) return 'clear';
  return 'none';
}

/**
 * What Back means at a given station. The first station has no previous one, so
 * Back leaves the wizard instead of sitting disabled: with no `:disabled` rule
 * in the stylesheet a disabled Back was indistinguishable from a live one, so
 * it read as a button that simply did nothing.
 */
export function wizardBackAction(step: number): 'leave' | 'previous' {
  return step === 0 ? 'leave' : 'previous';
}

export function explorerBlocker(
  chainIds: number[],
  selection: Record<string, string[]>,
  entriesByChain: Record<string, ExplorerEntry[] | undefined>,
  chainName: (chainId: number) => string
): string | undefined {
  for (const chainId of chainIds) {
    const selected = new Set(selection[String(chainId)] ?? []);
    const entries = entriesByChain[String(chainId)] ?? [];
    const unmapped = entries.find(
      (entry) => selected.has(entry.id) && !entry.verifierPluginId
    );
    if (unmapped)
      return `${chainName(chainId)}: ${unmapped.label ?? unmapped.url} needs a verifier type`;
    const needsConfig = entries.find(
      (entry) => selected.has(entry.id) && entry.needsConfig
    );
    if (needsConfig)
      return `${chainName(chainId)}: ${needsConfig.label ?? needsConfig.url} needs configuration`;
  }
  return undefined;
}

export function needsWorkflowDraftHydration(
  workflowRepo: string | null,
  workflowName: string | null,
  workflowState: unknown,
  workflowRef?: { repoPathOrUrl: string; name: string; docHash?: string }
): boolean {
  return Boolean(
    workflowRepo &&
      workflowName &&
      workflowState &&
      (workflowRef?.repoPathOrUrl !== workflowRepo ||
        workflowRef.name !== workflowName ||
        workflowRef.docHash !== (workflowState as { docHash?: string }).docHash)
  );
}

function WizardNav({
  blocker,
  onBack,
  onContinue,
}: {
  blocker?: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {/* Never disabled: on the first station Back leaves the wizard, which is
          the only thing "back" can mean there. It used to be disabled instead,
          and with no :disabled styling in the sheet it read as a live button
          that swallowed every click. */}
      <button type="button" className="btn btn-secondary" onClick={onBack}>
        <ArrowLeft size={15} /> Back
      </button>
      <div className="flex items-center gap-3 min-w-0">
        {blocker && (
          <span className="text-sm text-warn truncate">{blocker}</span>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(blocker)}
          onClick={onContinue}
        >
          Continue <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

export default function DeployWizardPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const stateExplorers = useAppSelector((state) => state.explorers.byChain);
  const [step, setStep] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const workflowRepo = searchParams.get('workflowRepo');
  const workflowName = searchParams.get('workflow');
  const workflowState = useAppSelector((state) =>
    workflowRepo && workflowName
      ? selectWorkflowDocument(state, workflowRepo, workflowName)
      : undefined
  );
  const composerMode = Boolean(draft.composition);
  const composerPluginId = draft.composition?.pluginId;
  const [descriptor, setDescriptor] = useState<DeploymentTypeInfo>();
  // The composer swaps only the first station: products become contracts on
  // Continue, so the rest of the wizard runs unchanged. Its label comes from
  // the deployment-type descriptor.
  const wizardSteps = composerMode
    ? [{ id: 'composer', label: descriptor?.label ?? 'Compose' }, ...STEPS.slice(1)]
    : STEPS;
  const composer = useDeploymentComposer(draft.composition);
  const deploymentType = searchParams.get('deploymentType');
  const draftActive = draft.contracts.length > 0 || composerMode;
  // Shared by the header arrow and by Back on the first station, so the two
  // cannot drift on where leaving the wizard lands.
  const leaveWizard = () =>
    navigate(draft.workflowRef ? '/workflows' : '/deployments');
  const {
    entries: artifactEntries,
    artifacts,
    retry: retryArtifact,
  } = useDeploymentArtifacts(draft.contracts);
  const contractsValid =
    draft.contracts.length > 0 &&
    draft.contracts.every(
      (contract) => artifactEntries[contract.id]?.status === 'ready'
    );
  const stepLabels = Object.fromEntries(
    draft.steps.map((draftStep, index) => [
      draftStep.id,
      draftStep.kind === 'deploy'
        ? (draft.contracts.find(
            (contract) => contract.id === draftStep.contractId
          )?.contractName ?? replaceIdsForDisplay(draftStep.id))
        : draftStep.signature
          ? `Call ${draftStep.signature}`
          : `Call #${index + 1}`,
    ])
  );

  // Visiting the wizard is what "sees" pending additions: clear the sidebar
  // badge on mount.
  useEffect(() => {
    dispatch(markDraftSeen());
  }, [dispatch]);
  useEffect(() => {
    const action = composerEntryAction(deploymentType, draft);
    if (action === 'start') dispatch(startComposition(deploymentType!));
    else if (action === 'clear') dispatch(clearDraft());
    else if (action === 'conflict') {
      // Real work for another deployment type is in progress. It is not
      // discarded, so the honest move is to drop the requested type from the
      // URL — leaving it there would show one plugin's composer under
      // another's link — and say why the link did not do what it promised.
      navigate('/deploy', { replace: true });
      dispatch(
        triggerToast({
          title: 'Another deployment is in progress',
          // The requested type is a URL parameter: it is echoed sanitized,
          // like every other id the wizard puts on screen.
          description: `Finish or discard the ${sanitizeDisplayText(draft.composition!.pluginId, 64)} deployment before starting a ${sanitizeDisplayText(deploymentType!, 64)} one.`,
          variant: 'warning',
          duration: 8000,
        })
      );
    }
  }, [dispatch, draft, deploymentType, navigate]);
  useEffect(() => {
    if (!composerPluginId) return;
    let cancelled = false;
    void apiClient
      .request('listDeploymentTypes', {})
      .then((response) => {
        if ('data' in response && !cancelled)
          setDescriptor(
            response.data.deploymentTypes.find(
              (item) => item.pluginId === composerPluginId
            )
          );
      })
      .catch(() => {
        // The label is cosmetic; composition itself reports real failures.
      });
    return () => {
      cancelled = true;
    };
  }, [composerPluginId]);
  useEnsureChainMetadata(draft.chains);
  useEffect(() => {
    if (workflowRepo && workflowName)
      dispatch(workflowsApi.get(workflowRepo, workflowName));
  }, [dispatch, workflowName, workflowRepo, workflowState]);
  useEffect(() => {
    if (
      !needsWorkflowDraftHydration(
        workflowRepo,
        workflowName,
        workflowState,
        draft.workflowRef
      )
    )
      return;
    if (!workflowRepo || !workflowName || !workflowState) return;
    const changed =
      draft.workflowRef?.repoPathOrUrl === workflowRepo &&
      draft.workflowRef.name === workflowName &&
      draft.workflowRef.docHash !== workflowState.docHash;
    dispatch(
      hydrateWorkflowDraft({
        repoPathOrUrl: workflowRepo,
        name: workflowName,
        docHash: workflowState.docHash,
        document: workflowState.document,
      })
    );
    if (changed) {
      dispatch(
        triggerToast({
          title: 'Workflow changed',
          description: 'The workflow changed on disk, so its deployment draft was rebuilt.',
          variant: 'warning',
          duration: 8000,
        })
      );
    }
  }, [
    dispatch,
    draft.workflowRef?.name,
    draft.workflowRef?.repoPathOrUrl,
    workflowName,
    workflowRepo,
    workflowState,
  ]);
  const { plan, planProblem } = useMemo(() => {
    try {
      if (draft.workflowRef && draft.workflowDocument) {
        const projected = projectWorkflowPlan({
          document: workflowDocumentFromDraft(draft),
          repoPathOrUrl: draft.workflowRef.repoPathOrUrl,
          chains: draft.chains,
          includedStepIds: draft.workflowIncludedStepIds ?? {},
          resolutions: draft.externalResolutions ?? [],
        });
        return {
          plan: { ...projected, signers: cloneJson(draft.signers) },
          planProblem: undefined,
        };
      }
      return { plan: planFromDraft(draft, chains), planProblem: undefined };
    } catch (error) {
      return {
        plan: null,
        planProblem:
          error instanceof Error ? error.message : 'The plan is incomplete',
      };
    }
  }, [draft, chains]);
  // Owned here rather than in Review so the steps page and Review share one
  // report — a second call site would mean a second validate request per edit.
  const validation = useValidationReport(plan ?? undefined);
  const chainName = (chainId: number) =>
    chains.find((chain) => chain.chainId === chainId)?.name ??
    `Chain ${chainId}`;

  // The composer station's blocker: transport errors, then the server's own
  // blocker, then what is locally knowable without a round trip, then a
  // recomposition conflict, then artifact readiness after materialization.
  const composerBlocker = !composerMode
    ? undefined
    : (composer.error ??
      composer.blocker ??
      (composer.hasResponse
        ? composerRequiredBlocker(
            composer.fields,
            draft.composition!.values,
            draft.composition!.artifacts
          )
        : 'Loading composer…') ??
      (composer.composition
        ? compositionMaterializationProblem(draft, composer.composition)
        : undefined) ??
      (draft.contracts.length > 0 && !contractsValid
        ? 'Product artifacts are not ready yet'
        : undefined));
  // Continuing out of the composer always re-composes with the values on
  // screen — a stale earlier response must never be what turns into steps —
  // and only a response carrying a complete composition materializes.
  const continueComposer = async () => {
    const response = await composer.compose();
    if (!response?.composition) return;
    if (compositionMaterializationProblem(draft, response.composition)) return;
    dispatch(
      applyComposition({
        binding: response.binding,
        composition: response.composition,
      })
    );
    setStep(1);
  };

  // The first reason the current step cannot continue — surfaced next to the
  // disabled button. A silently disabled Continue with the offending chain
  // scrolled off-screen reads as a dead end.
  const blockers: Array<string | undefined> = [
    composerMode
      ? composerBlocker
      : contractsValid
        ? undefined
        : 'Select at least one deployable contract',
    (() => {
      if (draft.chains.length === 0) return 'Select at least one chain';
      const missing = draft.chains.find(
        (chainId) => !draft.rpcSelection[String(chainId)]
      );
      return missing === undefined
        ? undefined
        : `${chainName(missing)} needs an RPC endpoint`;
    })(),
    explorerBlocker(
      draft.chains,
      draft.explorerSelection,
      stateExplorers,
      chainName
    ),
    (() => {
      const unresolved = draft.chains.find(
        (chainId) =>
          !draft.signers.perChain?.[String(chainId)] && !draft.signers.global
      );
      return unresolved === undefined
        ? undefined
        : `${chainName(unresolved)} has no signer`;
    })(),
    (() => {
      if (planProblem) return planProblem;
      if (!draft.workflowDocument) return undefined;
      const slots = collectUnboundWorkflowSlots({
        document: workflowDocumentFromDraft(draft),
        repoPathOrUrl: draft.workflowRef!.repoPathOrUrl,
        chains: draft.chains,
        includedStepIds: draft.workflowIncludedStepIds ?? {},
        resolutions: draft.externalResolutions,
      });
      return slots.length
        ? `Resolve ${slots.length} per-chain pointer ${slots.length === 1 ? 'slot' : 'slots'}`
        : undefined;
    })(),
    draft.contractTypeSelectionPending ? 'Contract type is still loading' : undefined,
  ];

  const nav = step < wizardSteps.length - 1 && (
    <WizardNav
      blocker={
        blockers[step]
          ? replaceIdsForDisplay(blockers[step], stepLabels)
          : undefined
      }
      onBack={() =>
        wizardBackAction(step) === 'leave'
          ? leaveWizard()
          : setStep((value) => value - 1)
      }
      onContinue={() => {
        // Continuing out of the composer is what turns the composition into
        // the producer call, product deploy steps and their contracts. It
        // advances only after a fresh compose materializes successfully.
        if (composerMode && step === 0) {
          void continueComposer();
          return;
        }
        setStep((value) => value + 1);
      }}
    />
  );

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          aria-label="Back"
          onClick={leaveWizard}
        >
          <ArrowLeft size={18} />
        </button>
        {draftActive && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Discard deployment"
            title="Discard deployment"
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 size={18} />
          </button>
        )}
        <div className="flex-1">
          <h1 className="page-title mb-0">Deploy contracts</h1>
          <p className="text-sm text-muted">
            Create a frozen, recoverable deployment run.
          </p>
        </div>
        {draft.contracts.length > 0 && !draft.workflowRef && plan && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPromoteOpen(true)}
          >
            <Save size={15} /> Save as workflow
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard deployment?"
        description="Removes every added contract and all configuration in this deployment."
        confirmText="Discard"
        onConfirm={() => {
          dispatch(clearDraft());
          navigate('/deployments', { replace: true });
        }}
      />
      {plan && (
        <PromoteWorkflowDialog
          open={promoteOpen}
          onOpenChange={setPromoteOpen}
          input={{ plan }}
          hooks={draft.workflowOutputs?.hooks ?? []}
          onPromoted={() => navigate('/workflows')}
        />
      )}
      <WizardStepper
        steps={wizardSteps}
        currentIndex={step}
        onStepSelect={(index) => {
          if (index <= step) setStep(index);
        }}
      />
      {nav && <div className="mb-4">{nav}</div>}
      <div className="card-milky p-5">
        {step === 0 &&
          (draft.composition ? (
            <ComposerStep
              composition={draft.composition}
              fields={composer.fields}
              loading={composer.loading}
              error={composer.error}
              label={descriptor?.label}
              description={descriptor?.description}
            />
          ) : (
            <ContractsStep
              contracts={draft.contracts}
              artifactEntries={artifactEntries}
              onRemove={(contractId) => dispatch(removeContract(contractId))}
              onRetry={retryArtifact}
              workflowMode={Boolean(draft.workflowRef)}
            />
          ))}
        {step === 1 && <ChainsStep />}
        {step === 2 && <ExplorersStep />}
        {step === 3 && <SignersStep />}
        {step === 4 && <StepsStep artifacts={artifacts} report={validation.lastGoodReport} />}
        {step === 5 && plan && <ReviewStep plan={plan} validation={validation} />}
      </div>
    </div>
  );
}
