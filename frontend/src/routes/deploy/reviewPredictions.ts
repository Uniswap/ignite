import type {
  PredictedEntryInfo,
  ProvisionalStepInfo,
  ValidationReport,
} from '@ignite/api';

export interface ReviewPredictedAddress {
  chainId: string;
  stepId: string;
  // Absent when the prediction failed; `unavailableReason` says why.
  address?: string;
  provisional: boolean;
  // What the provisional chip should say: plain creates are nonce previews,
  // dynamic deterministic steps are mined during the run.
  provisionalLabel?: string;
  unavailableReason?: string;
}

/** Narrows the open validation details record at the UI boundary. */
export function reviewPredictedAddresses(
  report: ValidationReport | null | undefined
): ReviewPredictedAddress[] {
  return Object.entries(report?.chains ?? {}).flatMap(
    ([chainId, checklist]) => {
      const details = checklist.create2?.details;
      const provisionalInfos = Array.isArray(details?.provisionalSteps)
        ? (details.provisionalSteps as ProvisionalStepInfo[]).filter(
            (entry) => typeof entry?.stepId === 'string'
          )
        : [];
      const provisionalSteps = new Set(
        provisionalInfos.map((entry) => entry.stepId)
      );
      const predicted = details?.predicted;
      const predictedRows =
        !predicted || typeof predicted !== 'object' || Array.isArray(predicted)
          ? []
          : Object.entries(predicted as Record<string, unknown>).flatMap(
              ([stepId, value]) => {
                if (!value || typeof value !== 'object' || Array.isArray(value))
                  return [];
                const entry = value as PredictedEntryInfo;
                if (typeof entry.predictedAddress !== 'string') return [];
                const provisional =
                  entry.provisional === true || provisionalSteps.has(stepId);
                return [
                  {
                    chainId,
                    stepId,
                    address: entry.predictedAddress,
                    provisional,
                    ...(provisional
                      ? {
                          provisionalLabel:
                            entry.kind === 'create'
                              ? 'provisional — depends on signer nonce'
                              : entry.notes?.length
                                ? `provisional — ${entry.notes[0]}`
                                : 'provisional — mined during run',
                        }
                      : {}),
                  },
                ];
              }
            );
      const predictedIds = new Set(predictedRows.map((row) => row.stepId));
      // A step whose prediction failed has a reason but no address. Emitting a
      // row keeps the section visible instead of silently shrinking it.
      const unavailableRows = provisionalInfos.flatMap((entry) =>
        entry.degraded && !predictedIds.has(entry.stepId)
          ? [
              {
                chainId,
                stepId: entry.stepId,
                provisional: true,
                unavailableReason: entry.degraded,
              },
            ]
          : []
      );
      return [...predictedRows, ...unavailableRows];
    }
  );
}

/**
 * Rows for a single step, for the wizard's per-step address preview. The steps
 * page shows the same report Review does — it is simply rendered earlier.
 */
export function stepPredictionRows(
  report: ValidationReport | null | undefined,
  stepId: string
): ReviewPredictedAddress[] {
  return reviewPredictedAddresses(report).filter((row) => row.stepId === stepId);
}
