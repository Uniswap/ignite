import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ComposeDeploymentData,
  ComposedCallProducts,
  DeploymentComposerField,
  DeploymentTypeBinding,
} from '@ignite/api';
import { apiClient } from '../../store/api/client';
import { apiErrorMessage } from '../../utils/apiError';
import { cloneJson } from '../../utils/cloneJson';
import type { DeploymentCompositionDraft } from '../../store/features/deployments/types';

export interface ComposerResponseState {
  revision: number;
  binding: DeploymentTypeBinding;
  fields: DeploymentComposerField[];
  // The values/artifacts snapshot this response answered. A blocker only
  // binds while it still describes the inputs on screen.
  inputsKey: string;
  blocker?: string;
  composition?: ComposedCallProducts;
}

/**
 * Applies a compose response only while it is still the answer to the latest
 * request sent for this composition. Requests overlap — an artifact change
 * fires while an earlier container invocation is still running — and an older
 * result landing last would overwrite newer field selections with a stale
 * form. The server echoes the request's revision verbatim, so equality with
 * the latest sent revision is the freshness test.
 */
export function applyComposeResponse(
  current: ComposerResponseState | null,
  latestSent: number,
  response: ComposeDeploymentData,
  inputsKey: string
): ComposerResponseState | null {
  if (response.revision !== latestSent) return current;
  return {
    revision: response.revision,
    binding: response.binding,
    fields: response.fields,
    inputsKey,
    ...(response.blocker ? { blocker: response.blocker } : {}),
    ...(response.composition ? { composition: response.composition } : {}),
  };
}

export function composerInputsKey(
  composition: Pick<DeploymentCompositionDraft, 'values' | 'artifacts'>
): string {
  return JSON.stringify([composition.values, composition.artifacts]);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The first locally knowable reason the composer cannot continue. The server
 * blocker is authoritative; this only covers what needs no round trip, so a
 * required field left empty disables Continue without a container invocation.
 */
export function composerRequiredBlocker(
  fields: DeploymentComposerField[],
  values: Record<string, unknown>,
  artifacts: Record<string, unknown>
): string | undefined {
  for (const field of fields) {
    if (field.type === 'artifact') {
      if (field.required && !artifacts[field.key]) return `${field.label} is required`;
      continue;
    }
    const value = values[field.key];
    if (field.required && (value === undefined || value === ''))
      return `${field.label} is required`;
    if (
      field.type === 'address' &&
      typeof value === 'string' &&
      value !== '' &&
      !ADDRESS.test(value)
    )
      return `${field.label} must be a 0x address`;
  }
  return undefined;
}

export function useDeploymentComposer(
  composition: DeploymentCompositionDraft | undefined
) {
  const [state, setState] = useState<ComposerResponseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Monotonically increasing per mounted composer, echoed by the server.
  const revisionRef = useRef(0);
  const compositionRef = useRef(composition);
  compositionRef.current = composition;

  const compose = useCallback(async (): Promise<
    ComposeDeploymentData | undefined
  > => {
    const draft = compositionRef.current;
    if (!draft) return undefined;
    const revision = ++revisionRef.current;
    const inputsKey = composerInputsKey(draft);
    setLoading(true);
    setError(undefined);
    try {
      const response = await apiClient.request('composeDeployment', {
        body: {
          pluginId: draft.pluginId,
          compositionId: draft.compositionId,
          revision,
          values: cloneJson(draft.values),
          artifacts: cloneJson(draft.artifacts),
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      setState((current) =>
        applyComposeResponse(current, revisionRef.current, response.data, inputsKey)
      );
      // A caller materializes only from a response that is still current.
      return response.data.revision === revisionRef.current
        ? response.data
        : undefined;
    } catch (cause) {
      if (revision === revisionRef.current) setError(apiErrorMessage(cause));
      return undefined;
    } finally {
      if (revision === revisionRef.current) setLoading(false);
    }
  }, []);

  // Recompose when the dynamic form's inputs change: artifact and select
  // choices reshape the form the plugin returns. Plain text entry (address
  // typing) deliberately does not — a container per keystroke is the failure
  // mode the field vocabulary was designed to avoid.
  const selectKeys = useMemo(
    () =>
      new Set(
        (state?.fields ?? [])
          .filter((field) => field.type === 'select')
          .map((field) => field.key)
      ),
    [state?.fields]
  );
  const composeKey = useMemo(() => {
    if (!composition) return '';
    return JSON.stringify([
      composition.pluginId,
      composition.compositionId,
      composition.artifacts,
      Object.fromEntries(
        Object.entries(composition.values).filter(([key]) => selectKeys.has(key))
      ),
    ]);
  }, [composition, selectKeys]);
  const composeRef = useRef(compose);
  composeRef.current = compose;
  useEffect(() => {
    if (!composeKey) return;
    void composeRef.current();
  }, [composeKey]);

  // Address typing does not recompose, so a served blocker naming a value
  // the user has since filled would otherwise keep Continue disabled forever.
  // A blocker (and pre-Continue composition) binds only while the response
  // still describes the inputs on screen; Continue always re-composes fresh.
  const fresh = Boolean(
    state && composition && state.inputsKey === composerInputsKey(composition)
  );
  return {
    fields: state?.fields ?? [],
    blocker: fresh ? state?.blocker : undefined,
    composition: fresh ? state?.composition : undefined,
    binding: state?.binding,
    hasResponse: state !== null,
    loading,
    error,
    compose,
  };
}
