// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { DraftDeployExtras } from '../../../../store/features/deployments/types';
import { factoryProductPresentation } from '../DeployStepCard';

describe('factoryProductPresentation', () => {
  it('hides constructor args and initcode linking for every factory step', () => {
    // The factory supplies its product's constructor arguments onchain and
    // Ignite builds no initcode for it — these editors would collect values
    // nothing reads.
    expect(
      factoryProductPresentation({
        kind: 'factory',
        fulfilledBy: 'call-1',
        output: 'jar',
      })
    ).toEqual({ constructorArgs: false, libraries: false, transaction: false });
  });

  it('keeps transaction settings for a carry-the-call factory step', () => {
    expect(
      factoryProductPresentation({ kind: 'factory', signature: 'deploy()' })
    ).toEqual({ constructorArgs: false, libraries: false, transaction: true });
  });

  it('keeps every section for initcode strategies', () => {
    const strategies: Array<DraftDeployExtras['strategy'] | undefined> = [
      undefined,
      { kind: 'create' },
      { kind: 'create2' },
      { kind: 'plugin', pluginId: 'hook' },
    ];
    for (const strategy of strategies) {
      expect(factoryProductPresentation(strategy)).toEqual({
        constructorArgs: true,
        libraries: true,
        transaction: true,
      });
    }
  });
});
