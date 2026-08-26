import { allowedActions } from '@ignite/api';
import type { Lane, PauseContext, ResolveAction, Step } from '@ignite/api';
import { AlertTriangle } from 'lucide-react';

export const ACTION_LABELS: Record<ResolveAction, string> = {
  retry: 'Retry',
  edit: 'Edit & retry',
  skip: 'Skip step',
  'abort-lane': 'Abort lane',
  recheck: 'Re-check receipt',
  'confirm-hash': 'Confirm transaction hash',
  'mark-not-sent': 'Mark not sent',
  replace: 'Replace transaction',
  'keep-waiting': 'Keep waiting',
  'accept-deployed': 'Accept existing deployment',
  'record-deployed-address': 'Record deployed address…',
};

const PAUSE_COPY: Partial<Record<PauseContext['reason'], string>> = {
  'create2-collision': 'A contract already exists at the predicted address.',
  'created-code-missing': 'The transaction succeeded but no code appeared at the predicted address.',
  'pointer-unresolved': 'A referenced step has no deployed address.',
  'produced-address-occupied': 'Code already exists at an expected product address, so the producer paused before broadcasting. The whole output set is accepted or rejected together.',
  'produced-code-missing': 'The producer call succeeded, but no code exists at this product’s expected address. Re-check, or record the address it actually deployed to.',
};

interface PauseBannerProps {
  lane: Lane;
  planSteps: Step[];
  capability?: PauseContext['capability'];
  onAction: (action: ResolveAction) => void;
}

/**
 * The paused step's role in produced mode, derived from the frozen plan the
 * same way the server derives it: the producer call of at least one product,
 * or a produced product itself. Skipping either strands dependencies, which
 * is why the shared verb table needs to know.
 */
export function producedRoleFor(
  planSteps: Step[],
  stepId: string | undefined
): PauseContext['producedRole'] {
  if (!stepId) return undefined;
  if (
    planSteps.some(
      (step) =>
        step.kind === 'deploy' &&
        step.strategy?.kind === 'plugin' &&
        step.strategy.producedBy?.stepId === stepId
    )
  )
    return 'producer';
  const step = planSteps.find((candidate) => candidate.id === stepId);
  if (
    step?.kind === 'deploy' &&
    step.strategy?.kind === 'plugin' &&
    step.strategy.producedBy
  )
    return 'product';
  return undefined;
}

export function actionsForPausedLane(
  lane: Lane,
  capability: PauseContext['capability'],
  planSteps: Step[] = []
): ResolveAction[] {
  if (!lane.pause) return [];
  const paused = lane.steps[lane.pause.stepIndex];
  const attempt = paused?.attempts.find(
    (item) => item.id === lane.pause?.attemptId
  );
  const producedRole = producedRoleFor(planSteps, paused?.stepId);
  return allowedActions({
    reason: lane.pause.reason,
    capability,
    submitted: Boolean(attempt?.txHash || attempt?.rawTx),
    hasIntent: Boolean(attempt?.expected),
    ...(producedRole ? { producedRole } : {}),
  });
}

export default function PauseBanner({
  lane,
  planSteps,
  capability,
  onAction,
}: PauseBannerProps) {
  if (!lane.pause) return null;
  if (!capability && lane.pause.reason === 'receipt-timeout') {
    return (
      <div className="card-milky p-4 border border-warn/30 text-sm text-muted">
        Loading signer capability before showing safe resolution actions…
      </div>
    );
  }
  // The banner IS the shared verb table — no post-filtering. A recheck
  // without a known hash is a harmless engine-side no-op, and hiding shared
  // verbs here would desynchronize the UI from the enforcement contract.
  const safeActions = actionsForPausedLane(lane, capability ?? 'sign-and-send', planSteps);
  const details = lane.pause.details as Record<string, unknown> | undefined;
  const assertion = typeof details?.assertion === 'string' ? details.assertion : undefined;
  return (
    <div className="card-milky p-4 border border-warn/30">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-warn mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Lane paused: {lane.pause.reason}</div>
          <p className="text-sm text-muted mt-1">{PAUSE_COPY[lane.pause.reason] ?? lane.pause.error}</p>
          {PAUSE_COPY[lane.pause.reason] && lane.pause.error && (
            <p className="text-xs text-muted mt-1">{lane.pause.error}</p>
          )}
          {lane.pause.reason === 'needs-review' && details && (
            <details className="text-xs text-muted mt-2">
              <summary className="cursor-pointer">Capture details{assertion ? `: ${assertion}` : ''}</summary>
              <div className="mono-data mt-1" style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(details)}</div>
            </details>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            {safeActions.map((action) => (
              <button
                key={action}
                type="button"
                className={
                  action === 'abort-lane'
                    ? 'btn btn-sm btn-danger'
                    : 'btn btn-sm btn-secondary'
                }
                onClick={() => onAction(action)}
              >
                {ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
