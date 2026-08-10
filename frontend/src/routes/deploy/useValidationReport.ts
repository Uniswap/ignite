import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DeploymentHookInfo,
  DeploymentPlan,
  ValidationReport,
} from '@ignite/api';
import { type NavigateFunction, useNavigate } from 'react-router-dom';
import { ApiError } from '@ignite/api/client';
import { apiClient } from '../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { workflowRunRequestFromDraft } from '../../store/features/deployments/workflowDraft';
import { triggerToast } from '../../store/middleware/toastListener';

export function bounceOutOfSyncWorkflowRun(
  cause: unknown,
  dispatch: (action: ReturnType<typeof triggerToast>) => unknown,
  navigate: NavigateFunction
): boolean {
  if (
    !(cause instanceof ApiError) ||
    cause.status !== 409 ||
    cause.body.code !== 'WORKFLOW_OUT_OF_SYNC'
  )
    return false;
  dispatch(
    triggerToast({
      title: 'Workflow is out of sync',
      description: 'Install or update it first.',
      variant: 'error',
      duration: 8000,
    })
  );
  navigate('/workflows', { replace: true });
  return true;
}

export function useValidationReport(plan: DeploymentPlan | undefined) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const draft = useAppSelector((state) => state.deployDraft);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deploymentHooks, setDeploymentHooks] = useState<DeploymentHookInfo[]>(
    []
  );
  const [hooksLoaded, setHooksLoaded] = useState(false);
  // Kept alongside `report` rather than replacing it: Review clears `report` on
  // a failed validate, which would blank rows that were correct a moment ago
  // for consumers that validate while the draft is still being edited.
  const [lastGoodReport, setLastGoodReport] = useState<ValidationReport | null>(
    null
  );
  const rpcSelection = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(draft.rpcSelection).map(([chainId, rpc]) => [
          chainId,
          rpc.endpointId,
        ])
      ),
    [draft.rpcSelection]
  );

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .request('listDeploymentHooks', {})
      .then((response) => {
        if ('data' in response && !cancelled)
          setDeploymentHooks(response.data.deploymentHooks);
      })
      .catch(() => {
        // Validation remains authoritative and will surface selected hook
        // warnings; a transient discovery failure must not strand Review.
      })
      .finally(() => {
        if (!cancelled) setHooksLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installedHookIds = useMemo(
    () => deploymentHooks.map((hook) => hook.pluginId),
    [deploymentHooks]
  );
  const workflowRequest = useMemo(
    () => workflowRunRequestFromDraft(draft, installedHookIds),
    [draft, installedHookIds]
  );

  const validate = useCallback(async () => {
    // The wizard mounts this hook before the plan exists on early steps; there
    // is nothing to validate until it does.
    if (!plan) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.request('validateDeployment', {
        body: {
          plan,
          rpcSelection,
          explorerSelection: draft.explorerSelection,
          ...(workflowRequest ? { workflow: workflowRequest } : {}),
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      const next = {
        chains: response.data.chains,
        ...(response.data.run ? { run: response.data.run } : {}),
      };
      setReport(next);
      setLastGoodReport(next);
    } catch (cause) {
      setReport(null);
      if (bounceOutOfSyncWorkflowRun(cause, dispatch, navigate)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [
    dispatch,
    draft.explorerSelection,
    navigate,
    plan,
    rpcSelection,
    workflowRequest,
  ]);

  useEffect(() => {
    void validate();
  }, [validate]);

  return {
    report,
    lastGoodReport,
    loading,
    error,
    // Review reports its launch and acknowledgement failures through the same
    // banner, so the error state stays single rather than being merged from two
    // sources at the render site.
    setError,
    deploymentHooks,
    hooksLoaded,
    installedHookIds,
    workflowRequest,
    rpcSelection,
    revalidate: validate,
  };
}
