// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DeploymentPlan } from '@ignite/api';
import {
  promotionApplyRequest,
  promotionNameValid,
  promotionPreviewRequest,
} from '../PromoteWorkflowDialog';

const plan = {
  schemaVersion: 1,
  contracts: [],
  steps: [],
  chains: [],
  signers: {},
} as DeploymentPlan;

describe('workflow promotion request builders', () => {
  it('validates workflow names with the shared wire pattern', () => {
    expect(promotionNameValid('release-1')).toBe(true);
    expect(promotionNameValid('Release 1')).toBe(false);
  });

  it('builds preview and apply requests for a draft', () => {
    expect(promotionPreviewRequest({ kind: 'repo', repoPathOrUrl: '/repo', name: 'release' }, { plan })).toEqual({
      mode: 'preview',
      target: { kind: 'repo', repoPathOrUrl: '/repo', name: 'release' },
      plan,
    });
    expect(
      promotionApplyRequest({ kind: 'repo', repoPathOrUrl: '/repo', name: 'release' }, { plan }, 'preview-1', {
        hooks: ['chronicles'],
        overwrite: true,
        tagChoiceBySourceId: { token: 'v1' },
      })
    ).toEqual({
      mode: 'apply',
      previewId: 'preview-1',
      target: { kind: 'repo', repoPathOrUrl: '/repo', name: 'release' },
      plan,
      hooks: ['chronicles'],
      overwrite: true,
      tagChoiceBySourceId: { token: 'v1' },
    });
  });

  it('adds adoption only for a run promotion', () => {
    expect(
      promotionApplyRequest(
        { kind: 'repo', repoPathOrUrl: '/repo', name: 'release' },
        { runId: 'run-1' },
        'preview-1',
        { hooks: [], adopt: true }
      )
    ).toMatchObject({ runId: 'run-1', adoptRunIds: ['run-1'] });
  });

  it('builds a local promotion target', () => {
    expect(promotionPreviewRequest({ kind: 'local', name: 'release' }, { plan })).toMatchObject({
      target: { kind: 'local', name: 'release' },
    });
  });
});
