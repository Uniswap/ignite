// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { parseAbiItem } from 'viem';
import {
  deployCandidates,
  factoryCallSignature,
  parsedFactoryFunction,
  productsOf,
} from '../factorySignatures';

// The motivating factory (tjar): one call deploys two contracts.
const tjarDeploy = {
  type: 'function',
  name: 'deploy',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'revenueToken', type: 'address' },
    { name: 'revenueRecipient', type: 'address' },
    { name: 'threshold', type: 'uint256' },
    { name: 'owner', type: 'address' },
    { name: 'configSetter', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [
    { name: 'jar', type: 'address' },
    { name: 'releaser', type: 'address' },
  ],
};

describe('deployCandidates', () => {
  it('keeps only state-changing functions that return an address', () => {
    const abi = [
      tjarDeploy,
      {
        type: 'function',
        name: 'predictJar',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'address' }],
      },
      {
        type: 'function',
        name: 'pureHelper',
        stateMutability: 'pure',
        inputs: [],
        outputs: [{ name: '', type: 'address' }],
      },
      {
        type: 'function',
        name: 'setOwner',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [],
      },
      { type: 'event', name: 'Deployed' },
    ];
    expect(deployCandidates(abi).map((entry) => entry.name)).toEqual([
      'deploy',
    ]);
  });

  it('returns nothing for a non-array ABI', () => {
    expect(deployCandidates(undefined)).toEqual([]);
  });
});

describe('factoryCallSignature', () => {
  it('keeps parameter names and the named-outputs returns clause', () => {
    expect(factoryCallSignature(tjarDeploy)).toBe(
      'deploy(address revenueToken, address revenueRecipient, uint256 threshold, address owner, address configSetter, bytes32 salt) returns (address jar, address releaser)'
    );
  });

  it('expands tuple components so the signature stays parseable', () => {
    const signature = factoryCallSignature({
      type: 'function',
      name: 'deployPools',
      stateMutability: 'nonpayable',
      inputs: [
        {
          name: 'configs',
          type: 'tuple[]',
          components: [
            { name: 'fee', type: 'uint256' },
            { name: 'hook', type: 'address' },
          ],
        },
      ],
      outputs: [{ name: 'pool', type: 'address' }],
    });
    expect(signature).toBe(
      'deployPools((uint256 fee, address hook)[] configs) returns (address pool)'
    );
    expect(() => parseAbiItem(`function ${signature}`)).not.toThrow();
  });
});

describe('productsOf', () => {
  it('names each address output, indexing unnamed ones among all outputs', () => {
    expect(
      productsOf(
        'deploy(bytes32 salt) returns (uint256, address, address named)'
      )
    ).toEqual(['output1', 'named']);
  });

  it('is empty for an unparseable or missing signature', () => {
    expect(productsOf(undefined)).toEqual([]);
    expect(productsOf('not a signature')).toEqual([]);
  });
});

describe('parsedFactoryFunction', () => {
  it('parses the signature the flow generates', () => {
    const fn = parsedFactoryFunction(factoryCallSignature(tjarDeploy));
    expect(fn?.inputs.map((input) => input.name)).toEqual([
      'revenueToken',
      'revenueRecipient',
      'threshold',
      'owner',
      'configSetter',
      'salt',
    ]);
  });

  it('returns undefined instead of throwing on garbage', () => {
    expect(parsedFactoryFunction('???')).toBeUndefined();
    expect(parsedFactoryFunction(undefined)).toBeUndefined();
  });
});
