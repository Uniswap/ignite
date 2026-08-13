// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { initializerArgumentMaskedChainIds } from '../WrapperStepCard';

describe('wrapper initializer address-book masking', () => {
  it('masks only the initializer argument overridden on each chain', () => {
    const argsPerChain = {
      '1': {
        data: {
          $encode: {
            contractId: 'implementation',
            fn: 'initialize(address,address)',
            args: { admin: '0x1111111111111111111111111111111111111111' },
          },
        },
      },
      '10': { data: '0x1234' },
    };

    expect(
      initializerArgumentMaskedChainIds([1, 10], argsPerChain, 'data', 'admin')
    ).toEqual([1, 10]);
    expect(
      initializerArgumentMaskedChainIds([1, 10], argsPerChain, 'data', 'owner')
    ).toEqual([10]);
  });
});
