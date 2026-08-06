// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { SignerCascade, SignerRef } from '@ignite/api';
import {
  runSignerForChain,
  shortSignerAddress,
  signerAccountOptionLabel,
  signerAddressSummary,
  signerResolutionLabel,
  stepSignerAddressOptions,
  stepSignerForChain,
} from '../signerDisplay';

const signer = (accountId: string, address: string): SignerRef => ({
  pluginId: 'private-key',
  accountId,
  address,
});

const globalSigner = signer(
  'global',
  '0xde82000000000000000000000000000000002e97'
);
const chainSigner = signer(
  'chain',
  '0x123400000000000000000000000000000000abcd'
);
const stepSigner = signer('step', '0xabcd00000000000000000000000000000000cafe');

describe('signer display', () => {
  it('shows a labelled account with its short address', () => {
    expect(shortSignerAddress(globalSigner.address)).toBe('0xde82…2e97');
    expect(
      signerAccountOptionLabel('Private Key', {
        label: 'V4 Deployer',
        address: globalSigner.address,
      })
    ).toBe('Private Key · V4 Deployer (0xde82…2e97)');
  });

  it('does not repeat an address already embedded in the account label', () => {
    expect(
      signerAccountOptionLabel('Browser Wallet', {
        label: 'Account 1 (0xde82…2e97)',
        address: globalSigner.address,
      })
    ).toBe('Browser Wallet · Account 1 (0xde82…2e97)');
    expect(
      signerAccountOptionLabel('Private Key', {
        address: globalSigner.address,
      })
    ).toBe('Private Key · 0xde82…2e97');
  });

  it('resolves run and step signers in deployment precedence order', () => {
    const run: SignerCascade = {
      global: globalSigner,
      perChain: { '1': chainSigner },
    };
    const step: SignerCascade = {
      global: stepSigner,
      perChain: { '1': globalSigner },
    };

    expect(runSignerForChain(run, 1)).toBe(chainSigner);
    expect(runSignerForChain(run, 2)).toBe(globalSigner);
    expect(stepSignerForChain(run, step, 1)).toBe(globalSigner);
    expect(stepSignerForChain(run, step, 2)).toBe(stepSigner);
  });

  it('summarizes distinct effective addresses and unresolved chains', () => {
    expect(
      signerAddressSummary([globalSigner, globalSigner, chainSigner, undefined])
    ).toBe('0xde82…2e97 / 0x1234…abcd / unresolved');
    expect(signerResolutionLabel('Use run default', [globalSigner])).toBe(
      'Use run default (0xde82…2e97)'
    );
  });

  it("builds fill options from each chain's effective step signer", () => {
    const run: SignerCascade = {
      global: globalSigner,
      perChain: { '1': chainSigner },
    };
    expect(
      stepSignerAddressOptions(run, { global: stepSigner }, [
        { chainId: 1, label: 'Ethereum' },
        { chainId: 2, label: 'Base' },
      ])
    ).toEqual([
      {
        chainId: 1,
        chainLabel: 'Ethereum',
        address: stepSigner.address,
      },
      {
        chainId: 2,
        chainLabel: 'Base',
        address: stepSigner.address,
      },
    ]);
    expect(
      stepSignerAddressOptions(run, undefined, [
        { chainId: 1, label: 'Ethereum' },
        { chainId: 2, label: 'Base' },
      ])
    ).toEqual([
      {
        chainId: 1,
        chainLabel: 'Ethereum',
        address: chainSigner.address,
      },
      {
        chainId: 2,
        chainLabel: 'Base',
        address: globalSigner.address,
      },
    ]);
  });
});
