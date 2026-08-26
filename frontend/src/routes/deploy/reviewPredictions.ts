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
  // dynamic deterministic steps are mined during the run. Render sites key the
  // chip off this rather than off `provisional`, because "provisional" claims
  // an address will firm up and a row with no address has none to firm up.
  provisionalLabel?: string;
  // The untruncated note behind a shortened `provisionalLabel`, for the chip's
  // tooltip. Only set when the two actually differ, so a render site can pass
  // it straight to `title` and get no tooltip when there is nothing more to say.
  provisionalDetail?: string;
  unavailableReason?: string;
  // The stand-in shown where the address would go. Computed here because two
  // render sites composed the same sentence independently and could drift.
  unavailableLabel?: string;
}

/**
 * Collapses the argument list of a signature mentioned in a note. A produced
 * product's note names the whole producer function — every parameter plus the
 * return tuple — and the chip that carries it is `white-space: nowrap`, so the
 * untouched text sets the review card's min-content width and pushes both the
 * predicted address and the launch button off screen. The full text stays
 * available as a tooltip; notes with no argument list are returned unchanged.
 */
export function compactSignatureNote(note: string): string {
  const open = note.indexOf('(');
  return open === -1 ? note : `${note.slice(0, open)}(…)`;
}

function provisionalChip(entry: PredictedEntryInfo): {
  provisionalLabel: string;
  provisionalDetail?: string;
} {
  if (entry.kind === 'create')
    return { provisionalLabel: 'provisional — depends on signer nonce' };
  const note = entry.notes?.length ? entry.notes[0] : undefined;
  if (!note) return { provisionalLabel: 'provisional — mined during run' };
  const compact = compactSignatureNote(note);
  return {
    provisionalLabel: `provisional — ${compact}`,
    ...(compact === note ? {} : { provisionalDetail: `provisional — ${note}` }),
  };
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
                    ...(provisional ? provisionalChip(entry) : {}),
                  },
                ];
              }
            );
      const predictedIds = new Set(predictedRows.map((row) => row.stepId));
      // A step whose prediction failed has a reason but no address. Emitting a
      // row keeps the section visible instead of silently shrinking it. It
      // carries no `provisionalLabel`: there is no address here that a later
      // run will settle, so a "provisional" chip would misdescribe the row.
      const unavailableRows = provisionalInfos.flatMap((entry) =>
        entry.degraded && !predictedIds.has(entry.stepId)
          ? [
              {
                chainId,
                stepId: entry.stepId,
                provisional: true,
                unavailableReason: entry.degraded,
                unavailableLabel: `unavailable — ${entry.degraded}`,
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
  return reviewPredictedAddresses(report).filter(
    (row) => row.stepId === stepId
  );
}
