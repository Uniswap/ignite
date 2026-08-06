import { useState } from 'react';
import { Box, Loader2, X } from 'lucide-react';
import type { DraftContract } from '../../../store/features/deployments/types';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';
import { useAppDispatch, useAppSelector } from '../../../store';
import { toggleWorkflowStep, workflowDependentsForExclusion } from '../../../store/features/deployments/deployDraftSlice';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { artifactVariantFromPath } from '../../../utils/artifactVariants';
import { findVersionForPin, pinChipText } from '../../../utils/pinDisplay';
import type { DeploymentArtifactEntry } from '../useDeploymentArtifacts';

interface ContractsStepProps {
  contracts: DraftContract[];
  artifactEntries: Record<string, DeploymentArtifactEntry>;
  onRemove: (contractId: string) => void;
  onRetry: (contractId: string) => void;
  workflowMode?: boolean;
}

export default function ContractsStep({
  contracts,
  artifactEntries,
  onRemove,
  onRetry,
  workflowMode = false,
}: ContractsStepProps) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  // The draft pin only carries a ref on some entry paths; the server's version
  // record is what reliably holds the tag, so the chip resolves it from there.
  const repositories = useAppSelector((state) => state.repositories.repositories);
  const [pendingToggle, setPendingToggle] = useState<string>();
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-lg font-semibold">Contracts</h2>
        <p className="text-sm text-muted">
          Add or remove the contracts included in this deployment. Execution
          order is configured in Steps.
        </p>
      </div>
      {contracts.length === 0 ? (
        <div className="card-milky p-8 text-center text-muted">
          Choose Deploy from a compiled contract or select artifacts in a
          repository.
        </div>
      ) : (
        <div className="glass-list">
          {contracts.map((contract) => {
            const artifactEntry = artifactEntries[contract.id];
            const libraryNames =
              artifactEntry?.status === 'ready'
                ? Object.values(artifactEntry.artifact.creationCodeLinkReferences ?? {}).flatMap(
                    (source) => Object.keys(source as Record<string, unknown>)
                  )
                : [];
            const variant = contract.origin === 'contract-type'
              ? undefined
              : artifactVariantFromPath(contract.artifactPath, contract.contractName);
            return (
            <div key={contract.id} className="list-row flex items-center gap-3">
              <Box size={17} className="text-info" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {contract.contractName}
                </div>
                <div className="mono-data text-muted truncate">
                  {contract.origin === 'contract-type' ? `${contract.pluginId} @ ${contract.versionLabel}` : `${decodeUrlEncodingForDisplay(contract.sourcePath)} · ${contract.frameworkId}`}
                </div>
                {(contract.origin !== 'contract-type' && (contract.pin || variant)) && <div className="flex flex-wrap gap-1 mt-1">
                  {contract.pin && <span className="chip chip-info">{pinChipText(contract.pin, findVersionForPin(repositories, contract.pin))}</span>}
                  {variant && <span className="chip">{variant}</span>}
                </div>}
                {artifactEntry?.status === 'loading' && (
                  <div className="text-xs text-muted flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" /> Loading ABI,
                    bytecode, and library links…
                  </div>
                )}
                {libraryNames.length > 0 && (
                  <div className="text-xs text-muted">Uses libraries: {libraryNames.join(', ')}</div>
                )}
                {artifactEntry?.status === 'error' && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-err">
                    <span>Artifact details could not be loaded: {artifactEntry.message}</span>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRetry(contract.id)}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
              {!workflowMode && contract.origin !== 'contract-type' && <button
                type="button"
                className="btn btn-sm btn-secondary"
                aria-label={`Remove ${contract.contractName} from deployment`}
                title="Remove from deployment"
                onClick={() => onRemove(contract.id)}
              >
                <X size={14} />
              </button>}
              {workflowMode && (
                <div className="grid gap-2 min-w-56">
                  {draft.steps.filter((step) => step.kind === 'deploy' && step.contractId === contract.id).map((step) => (
                    <label key={step.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.workflowIncludedStepIds?.[step.id] !== false} onChange={() => {
                        const dependents = workflowDependentsForExclusion(draft, step.id);
                        if (draft.workflowIncludedStepIds?.[step.id] !== false && dependents.length) setPendingToggle(step.id);
                        else dispatch(toggleWorkflowStep(step.id));
                      }} />
                      <span className="mono-data truncate">{decodeUrlEncodingForDisplay(step.id)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ); })}
        </div>
      )}
      <ConfirmDialog open={Boolean(pendingToggle)} onOpenChange={(open) => { if (!open) setPendingToggle(undefined); }} title="Exclude a depended-on step?" description={pendingToggle ? `These steps depend on it: ${workflowDependentsForExclusion(draft, pendingToggle).map(decodeUrlEncodingForDisplay).join(', ')}. Their pointers must be resolved per chain before continuing.` : ''} confirmText="Exclude step" variant="warning" onConfirm={() => { if (pendingToggle) dispatch(toggleWorkflowStep(pendingToggle)); }} />
    </section>
  );
}
