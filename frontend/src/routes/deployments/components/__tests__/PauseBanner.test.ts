// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { allowedActions, type Lane, type PauseContext, type Step } from '@ignite/api';
import { ACTION_LABELS, actionsForPausedLane, producedRoleFor } from '../PauseBanner';

function laneFor(ctx: PauseContext, stepId = 'deploy-token'): Lane {
  return {
    chainId: 1,
    status: 'paused',
    currentStepIndex: 0,
    pause: {
      reason: ctx.reason,
      stepIndex: 0,
      error: 'paused',
      attemptId: 'attempt-1',
    },
    steps: [
      {
        stepId,
        status: 'failed',
        attempts: [
          {
            id: 'attempt-1',
            startedAt: new Date(0).toISOString(),
            ...(ctx.submitted
              ? { txHash: `0x${'1'.repeat(64)}` as `0x${string}` }
              : {}),
          },
        ],
      },
    ],
  };
}

// A producer call and one produced product, matching the shared-schema shape.
const producedPlan: Step[] = [
  {
    id: 'call-comp-1',
    kind: 'call',
    target: { kind: 'address', address: `0x${'21'.repeat(20)}` },
    signature: 'deploy(bytes32)',
    abiContractId: 'comp-1:abi',
  },
  {
    id: 'deploy-comp-1:jar',
    kind: 'deploy',
    contractId: 'comp-1:jar',
    strategy: {
      kind: 'plugin',
      pluginId: 'call-products-plugin',
      producedBy: { stepId: 'call-comp-1', outputIndex: 0 },
    },
  },
];

describe('PauseBanner actions', () => {
  it('uses the shared allowedActions table for every pause context', () => {
    const contexts: PauseContext[] = [
      { reason: 'estimation', capability: 'sign-only', submitted: false, hasIntent: false },
      { reason: 'revert', capability: 'sign-only', submitted: true, hasIntent: true },
      { reason: 'receipt-timeout', capability: 'sign-only', submitted: true, hasIntent: true },
      {
        reason: 'receipt-timeout',
        capability: 'sign-and-send',
        submitted: true, hasIntent: true,
      },
      { reason: 'needs-review', capability: 'sign-and-send', submitted: true, hasIntent: true },
    ];
    for (const context of contexts) {
      expect(
        actionsForPausedLane(laneFor(context), context.capability)
      ).toEqual(allowedActions(context));
    }
  });

  it('renders the bounded produced-mode verb sets verbatim', () => {
    const occupied: PauseContext = { reason: 'produced-address-occupied', capability: 'sign-and-send', submitted: false, hasIntent: true };
    expect(
      actionsForPausedLane(laneFor(occupied, 'call-comp-1'), occupied.capability, producedPlan)
    ).toEqual(['retry', 'edit', 'abort-lane']);
    const missing: PauseContext = { reason: 'produced-code-missing', capability: 'sign-and-send', submitted: true, hasIntent: true };
    expect(
      actionsForPausedLane(laneFor(missing, 'deploy-comp-1:jar'), missing.capability, producedPlan)
    ).toEqual(['recheck', 'record-deployed-address', 'abort-lane']);
  });

  it('passes producedRole so ordinary pauses on produced steps lose skip and accept-deployed', () => {
    const context: PauseContext = { reason: 'revert', capability: 'sign-and-send', submitted: false, hasIntent: true };
    const actions = actionsForPausedLane(laneFor(context, 'call-comp-1'), context.capability, producedPlan);
    expect(actions).toEqual(
      allowedActions({ ...context, producedRole: 'producer' })
    );
    expect(actions).not.toContain('skip');
    expect(actions).not.toContain('accept-deployed');
  });
});

describe('producedRoleFor', () => {
  it('derives the role from the frozen plan exactly like the server', () => {
    expect(producedRoleFor(producedPlan, 'call-comp-1')).toBe('producer');
    expect(producedRoleFor(producedPlan, 'deploy-comp-1:jar')).toBe('product');
    expect(producedRoleFor(producedPlan, 'deploy-other')).toBeUndefined();
    expect(producedRoleFor(producedPlan, undefined)).toBeUndefined();
  });

  it('does not mark ordinary plugin steps as produced', () => {
    const plan: Step[] = [
      {
        id: 'deploy-hooked',
        kind: 'deploy',
        contractId: 'hooked',
        strategy: { kind: 'plugin', pluginId: 'hook', salt: `0x${'11'.repeat(32)}` },
      },
    ];
    expect(producedRoleFor(plan, 'deploy-hooked')).toBeUndefined();
  });
});

it('labels every ResolveAction', () => {
  const actions = ['retry', 'edit', 'skip', 'abort-lane', 'recheck', 'confirm-hash', 'mark-not-sent', 'replace', 'keep-waiting', 'accept-deployed', 'record-deployed-address'] as const;
  expect(Object.keys(ACTION_LABELS).sort()).toEqual([...actions].sort());
  expect(Object.values(ACTION_LABELS).every(Boolean)).toBe(true);
});
