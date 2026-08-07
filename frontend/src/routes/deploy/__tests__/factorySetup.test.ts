// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ContractSource } from '@ignite/api';
import type {
  DraftCallStep,
  FactoryDraftSetup,
} from '../../../store/features/deployments/types';
import { factorySetupBlocker } from '../steps/FactorySetupStep';

const SIGNATURE =
  'deploy(address owner, bytes32 salt) returns (address jar, address releaser)';

function source(id: string, contractName: string): ContractSource {
  return {
    id,
    repoPathOrUrl: '/repo',
    frameworkId: 'foundry',
    artifactPath: `out/${contractName}.json`,
    contractName,
    sourcePath: `src/${contractName}.sol`,
  };
}

function completeSetup(): FactoryDraftSetup {
  return {
    callStepId: 'call-factory-1',
    source: source('factory-art', 'Factory'),
    address: `0x${'21'.repeat(20)}` as `0x${string}`,
    signature: SIGNATURE,
    products: {
      jar: source('jar-art', 'TokenJar'),
      releaser: source('rel-art', 'ExchangeReleaser'),
    },
  };
}

describe('factorySetupBlocker', () => {
  it('walks the operator through the setup in order', () => {
    expect(factorySetupBlocker(undefined, undefined)).toBe(
      'Pick the factory contract'
    );
    expect(factorySetupBlocker({ callStepId: 'c' }, undefined)).toBe(
      'Pick the factory contract'
    );
    expect(
      factorySetupBlocker({ ...completeSetup(), address: undefined }, undefined)
    ).toBe('Enter the factory address');
    expect(
      factorySetupBlocker(
        { ...completeSetup(), address: '0x12' as `0x${string}` },
        undefined
      )
    ).toBe('Enter the factory address');
    expect(
      factorySetupBlocker(
        { ...completeSetup(), signature: undefined },
        undefined
      )
    ).toBe('Pick the deploy function');
  });

  it('names the outputs still missing an artifact', () => {
    expect(
      factorySetupBlocker(
        {
          ...completeSetup(),
          products: { jar: source('jar-art', 'TokenJar') },
        },
        undefined
      )
    ).toBe('Map each deployed contract to an artifact: releaser');
    expect(
      factorySetupBlocker(
        { ...completeSetup(), products: undefined },
        undefined
      )
    ).toBe('Map each deployed contract to an artifact: jar, releaser');
  });

  it('accepts a complete setup', () => {
    expect(factorySetupBlocker(completeSetup(), undefined)).toBeUndefined();
  });

  it('reads the address from the generated call step once it exists', () => {
    // Post-generation the staging address is deliberately gone; the call
    // step's target is the truth the blocker must consult.
    const call: DraftCallStep = {
      id: 'call-factory-1',
      kind: 'call',
      target: { kind: 'address', address: `0x${'21'.repeat(20)}` },
    };
    expect(
      factorySetupBlocker({ ...completeSetup(), address: undefined }, call)
    ).toBeUndefined();
    const blank: DraftCallStep = {
      id: 'call-factory-1',
      kind: 'call',
      target: { kind: 'address', address: '0x' as `0x${string}` },
    };
    expect(
      factorySetupBlocker({ ...completeSetup(), address: undefined }, blank)
    ).toBe('Enter the factory address');
  });
});
