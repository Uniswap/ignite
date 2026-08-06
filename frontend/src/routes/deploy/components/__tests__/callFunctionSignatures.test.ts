// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import {
  callArgumentInputs,
  callFunctionOptions,
  normalizeCallArgumentKeys,
} from '../callFunctionSignatures';

describe('callFunctionOptions', () => {
  it('uses canonical tuple signatures and keeps overloads distinct', () => {
    expect(
      callFunctionOptions([
        {
          type: 'function',
          name: 'configure',
          stateMutability: 'nonpayable',
          inputs: [
            {
              name: 'config',
              type: 'tuple',
              components: [
                { name: 'owner', type: 'address' },
                { name: 'limit', type: 'uint256' },
              ],
            },
          ],
        },
        {
          type: 'function',
          name: 'setValue',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'value', type: 'uint256' }],
        },
        {
          type: 'function',
          name: 'setValue',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'value', type: 'address' }],
        },
      ])
    ).toEqual([
      { signature: 'configure((address,uint256))', payable: false },
      { signature: 'setValue(uint256)', payable: false },
      { signature: 'setValue(address)', payable: false },
    ]);
  });

  it('uses target ABI names for step calls and positional keys for literals', () => {
    const abi = [
      {
        type: 'function',
        name: 'transferOwnership',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newOwner', type: 'address' }],
      },
    ];

    expect(
      callArgumentInputs('step', 'transferOwnership(address)', abi)
    ).toEqual([{ name: 'newOwner', type: 'address' }]);
    expect(
      callArgumentInputs('address', 'transferOwnership(address)', abi)
    ).toEqual([{ type: 'address' }]);
  });

  it('migrates saved positional values to resolved ABI names', () => {
    expect(
      normalizeCallArgumentKeys(
        { arg0: 'global', keep: 'value' },
        { '1': { arg0: 'chain' } },
        [{ name: 'newOwner', type: 'address' }]
      )
    ).toEqual({
      args: { newOwner: 'global', keep: 'value' },
      argsPerChain: { '1': { newOwner: 'chain' } },
    });
    expect(
      normalizeCallArgumentKeys(
        { newOwner: 'named', arg0: 'stale' },
        undefined,
        [{ name: 'newOwner', type: 'address' }]
      )
    ).toEqual({ args: { newOwner: 'named' }, argsPerChain: undefined });
  });
});
