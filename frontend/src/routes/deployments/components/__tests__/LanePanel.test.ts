// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { Lane, VerificationTask } from '@ignite/api';
import { displayAttempt, splitLaneVerificationTasks, stepAddressPresentation } from '../LanePanel';

const address = '0x0000000000000000000000000000000000000001';

function task(overrides: Partial<VerificationTask> = {}): VerificationTask {
  return {
    id: 'task-1', chainId: 1, address, bundleHash: 'bundle', encodedConstructorArgs: '0x',
    explorer: { entryId: 'etherscan', url: 'https://etherscan.io', verifierPluginId: 'etherscan', label: 'Etherscan' },
    origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token' }, status: 'verified', attempts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

const lane = {
  chainId: 1, status: 'completed', currentStepIndex: 1,
  steps: [{ stepId: 'deploy-token', status: 'confirmed', attempts: [], address }],
} as Lane;

describe('LanePanel helpers', () => {
  it('uses the last transaction-bearing attempt before the latest fallback', () => {
    const mined = { id: 'mined', startedAt: '2026-01-01', txHash: `0x${'1'.repeat(64)}`, gasUsed: '123456' };
    const latest = { id: 'latest', startedAt: '2026-01-02' };
    expect(displayAttempt([mined, latest])).toBe(mined);
    expect(displayAttempt([latest])).toBe(latest);
  });

  it('keeps address-mismatched and unmatched-step tasks in the orphan list', () => {
    const mismatch = task({ id: 'mismatch', address: '0x0000000000000000000000000000000000000002' });
    const missing = task({ id: 'missing', origin: { runId: 'run-1', stepId: 'legacy', contractId: 'token' } });
    const result = splitLaneVerificationTasks([task(), mismatch, missing], lane, new Set(['deploy-token']));
    expect(result.byStep['deploy-token']).toEqual([task()]);
    expect(result.orphans).toEqual([mismatch, missing]);
  });

  it('attaches captured-address tasks to their producing deployment step', () => {
    const capturedLane = { ...lane, steps: [{ ...lane.steps[0]!, captured: { admin: '0x0000000000000000000000000000000000000002' as `0x${string}` } }] };
    const captured = task({ address: '0x0000000000000000000000000000000000000002', origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token', captureKey: 'admin' } });
    const result = splitLaneVerificationTasks([captured], capturedLane, new Set(['deploy-token']));
    expect(result.byStep['deploy-token']).toEqual([captured]);
    expect(result.orphans).toEqual([]);
  });
});

describe('stepAddressPresentation', () => {
  const expected = '0x0000000000000000000000000000000000000011' as `0x${string}`;
  const recorded = '0x0000000000000000000000000000000000000022' as `0x${string}`;

  it('labels a produced product before confirmation as expected, not predicted', () => {
    // An eth_call result is not proof of what the mined transaction created.
    expect(stepAddressPresentation({ expectedAddress: expected })).toMatchObject({
      value: expected,
      chip: { label: 'expected', ok: false },
    });
  });

  it('confirms a produced product observed at its expected address', () => {
    expect(
      stepAddressPresentation({
        address: expected,
        expectedAddress: expected,
        addressProvenance: { kind: 'observed-at-expected', expectedAddress: expected, observedAt: '2026-01-01T00:00:00.000Z' },
      })
    ).toMatchObject({ value: expected, chip: { label: 'expected ✓', ok: true } });
  });

  it('never relabels an operator-recorded address as a prediction', () => {
    const presented = stepAddressPresentation({
      address: recorded,
      expectedAddress: expected,
      addressProvenance: { kind: 'operator-recorded', expectedAddress: expected, recordedAddress: recorded, recordedAt: '2026-01-01T00:00:00.000Z', note: 'nonce raced' },
    });
    expect(presented).toMatchObject({
      value: recorded,
      chip: { label: 'operator-recorded', ok: false },
    });
    expect(presented?.chip?.title).toContain('nonce raced');
  });

  it('keeps the CREATE2 prediction chips unchanged', () => {
    expect(stepAddressPresentation({ predictedAddress: expected })).toMatchObject({
      chip: { label: 'predicted', ok: false },
    });
    expect(
      stepAddressPresentation({ address: expected, predictedAddress: expected })
    ).toMatchObject({ chip: { label: 'predicted ✓', ok: true } });
    expect(stepAddressPresentation({ address: expected })?.chip).toBeUndefined();
    expect(stepAddressPresentation({})).toBeUndefined();
  });
});
