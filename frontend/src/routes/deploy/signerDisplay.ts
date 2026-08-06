import type { SignerCascade, SignerRef } from '@ignite/api';

export function shortSignerAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function signerAccountOptionLabel(
  providerName: string,
  account: { label?: string; address: string }
): string {
  const short = shortSignerAddress(account.address);
  const labelHasAddress = account.label
    ?.toLowerCase()
    .includes(account.address.slice(0, 6).toLowerCase());
  const accountLabel = account.label ?? short;
  return `${providerName} · ${accountLabel}${
    account.label && !labelHasAddress ? ` (${short})` : ''
  }`;
}

export function runSignerForChain(
  run: SignerCascade,
  chainId: number
): SignerRef | undefined {
  return run.perChain?.[String(chainId)] ?? run.global;
}

export function stepSignerForChain(
  run: SignerCascade,
  step: SignerCascade | undefined,
  chainId: number
): SignerRef | undefined {
  return (
    step?.perChain?.[String(chainId)] ??
    step?.global ??
    runSignerForChain(run, chainId)
  );
}

export function signerAddressSummary(
  signers: Array<SignerRef | undefined>
): string {
  const addresses = [
    ...new Set(
      signers.map((signer) =>
        signer ? shortSignerAddress(signer.address) : 'unresolved'
      )
    ),
  ];
  return addresses.length ? addresses.join(' / ') : 'unresolved';
}

export function signerResolutionLabel(
  label: string,
  signers: Array<SignerRef | undefined>
): string {
  return `${label} (${signerAddressSummary(signers)})`;
}
