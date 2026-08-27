// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ValidationReport } from '@ignite/api';
import {
  reviewPredictedAddresses,
  stepPredictionRows,
} from '../reviewPredictions';

describe('reviewPredictedAddresses', () => {
  it('marks provisional predicted entries for the ReviewStep marker', () => {
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {
                static: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000001',
                },
                dynamic: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000002',
                  provisional: true,
                },
                plain: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000003',
                  provisional: true,
                  kind: 'create',
                },
              },
              provisionalSteps: [{ stepId: 'dynamic' }],
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(reviewPredictedAddresses(report)).toEqual([
      {
        chainId: '1',
        stepId: 'static',
        address: '0x0000000000000000000000000000000000000001',
        provisional: false,
      },
      {
        chainId: '1',
        stepId: 'dynamic',
        address: '0x0000000000000000000000000000000000000002',
        provisional: true,
        provisionalLabel: 'provisional — mined during run',
      },
      {
        chainId: '1',
        stepId: 'plain',
        address: '0x0000000000000000000000000000000000000003',
        provisional: true,
        provisionalLabel: 'provisional — depends on signer nonce',
      },
    ]);
  });

  it('labels a produced product with its own prediction note, not "mined"', () => {
    // Nothing is mined for a produced product: its address came back from the
    // producer function's eth_call. The entry's note says so — show that.
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {
                'product-jar': {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000004',
                  provisional: true,
                  notes: ['returned by producer call'],
                },
              },
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(reviewPredictedAddresses(report)).toEqual([
      {
        chainId: '1',
        stepId: 'product-jar',
        address: '0x0000000000000000000000000000000000000004',
        provisional: true,
        provisionalLabel: 'provisional — returned by producer call',
      },
    ]);
  });

  it('collapses a producer signature note and keeps the full text for the tooltip', () => {
    // The untouched note is wider than the address it annotates, and the chip
    // carrying it cannot wrap — so it set the review card's width and pushed
    // the address and the launch button off screen.
    const signature =
      'deploy(address revenueToken, address revenueRecipient, uint256 threshold, address owner, address configSetter, bytes32 salt) returns (address jar, address releaser)';
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {
                'product-jar': {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000004',
                  provisional: true,
                  notes: [`returned by ${signature}`],
                },
              },
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(reviewPredictedAddresses(report)[0]).toEqual({
      chainId: '1',
      stepId: 'product-jar',
      address: '0x0000000000000000000000000000000000000004',
      provisional: true,
      provisionalLabel: 'provisional — returned by deploy(…)',
      provisionalDetail: `provisional — returned by ${signature}`,
    });
  });

  it('emits a row carrying the reason when a prediction was unavailable', () => {
    // A missing row is indistinguishable from "no such feature" — which is how
    // this was originally reported. Always render something.
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {},
              provisionalSteps: [
                {
                  stepId: 'jar',
                  degraded: 'execution reverted: not authorized',
                },
              ],
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(reviewPredictedAddresses(report)).toEqual([
      {
        chainId: '1',
        stepId: 'jar',
        provisional: true,
        unavailableReason: 'execution reverted: not authorized',
        unavailableLabel: 'unavailable — execution reverted: not authorized',
      },
    ]);
  });

  it('leaves an unavailable row without a provisional chip label', () => {
    // "Provisional" promises the address will firm up. There is no address
    // here, so the chip has nothing to say and must not be rendered.
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              provisionalSteps: [{ stepId: 'jar', degraded: 'no RPC' }],
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(
      reviewPredictedAddresses(report)[0]?.provisionalLabel
    ).toBeUndefined();
  });
});

describe('stepPredictionRows', () => {
  it('returns only the rows for the requested step, across chains', () => {
    const report = {
      chains: {
        '1': {
          create2: {
            details: {
              predicted: {
                jar: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000001',
                },
                other: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000002',
                },
              },
            },
          },
        },
        '10': {
          create2: {
            details: {
              predicted: {
                jar: {
                  predictedAddress:
                    '0x0000000000000000000000000000000000000003',
                },
              },
            },
          },
        },
      },
    } as unknown as ValidationReport;

    expect(stepPredictionRows(report, 'jar')).toEqual([
      {
        chainId: '1',
        stepId: 'jar',
        address: '0x0000000000000000000000000000000000000001',
        provisional: false,
      },
      {
        chainId: '10',
        stepId: 'jar',
        address: '0x0000000000000000000000000000000000000003',
        provisional: false,
      },
    ]);
  });

  it('returns an empty array when there is no report yet', () => {
    expect(stepPredictionRows(null, 'jar')).toEqual([]);
  });
});
