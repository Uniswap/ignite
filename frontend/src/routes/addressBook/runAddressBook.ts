import type { AddressBookEntry, Hex, RunRecord } from '@ignite/api';

export interface RunAddressCandidate {
  stepId: string;
  name: string;
  entry: AddressBookEntry;
  resolutions: Record<string, Hex>;
}

export function addressBookCandidatesFromRun(
  run: RunRecord,
  onlyStepId?: string
): RunAddressCandidate[] {
  const names = new Map(
    run.plan.contracts.map((contract) => [contract.id, contract.contractName])
  );
  const used = new Set<string>();
  return run.plan.steps.flatMap((step) => {
    if (step.kind !== 'deploy' || (onlyStepId && step.id !== onlyStepId))
      return [];
    const resolutions = Object.fromEntries(
      run.plan.chains.flatMap((chainId) => {
        const result = run.lanes[String(chainId)]?.steps.find(
          (candidate) => candidate.stepId === step.id
        );
        const acknowledged =
          result?.status === 'skipped' &&
          result.attempts.some(
            (attempt) => attempt.resolution === 'accept-deployed'
          );
        return result?.address &&
          (result.status === 'confirmed' || acknowledged)
          ? [[String(chainId), result.address]]
          : [];
      })
    );
    const addresses = Object.values(resolutions);
    if (!addresses.length) return [];
    const base = slugAddressBookName(names.get(step.contractId) ?? step.id);
    const name = uniqueName(base, used);
    used.add(name);
    const entry: AddressBookEntry = addresses.every(
      (address) => address.toLowerCase() === addresses[0]!.toLowerCase()
    )
      ? { name, address: addresses[0] }
      : { name, perChain: resolutions };
    return [{ stepId: step.id, name, entry, resolutions }];
  });
}

export function slugAddressBookName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '') || 'contract'
  );
}

export function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(withSuffix(base, suffix))) suffix += 1;
  return withSuffix(base, suffix);
}

export function candidateConflicts(
  existing: AddressBookEntry,
  candidate: RunAddressCandidate
): Array<{ chainId: string; current: Hex; incoming: Hex }> {
  return Object.entries(candidate.resolutions).flatMap(
    ([chainId, incoming]) => {
      const current = existing.perChain?.[chainId] ?? existing.address;
      return current && current.toLowerCase() !== incoming.toLowerCase()
        ? [{ chainId, current, incoming }]
        : [];
    }
  );
}

export function mergeRunCandidate(
  existing: AddressBookEntry,
  candidate: RunAddressCandidate,
  replaceChains: Set<string>
): AddressBookEntry {
  const next: AddressBookEntry = globalThis.structuredClone(existing);
  for (const [chainId, incoming] of Object.entries(candidate.resolutions)) {
    const current = next.perChain?.[chainId] ?? next.address;
    if (
      current &&
      current.toLowerCase() !== incoming.toLowerCase() &&
      !replaceChains.has(chainId)
    )
      continue;
    if (!current || current.toLowerCase() !== incoming.toLowerCase())
      (next.perChain ??= {})[chainId] = incoming;
  }
  if (next.address && next.perChain) {
    next.perChain = Object.fromEntries(
      Object.entries(next.perChain).filter(
        ([, address]) => address.toLowerCase() !== next.address!.toLowerCase()
      )
    );
    if (!Object.keys(next.perChain).length) delete next.perChain;
  }
  return next;
}

function withSuffix(base: string, suffix: number): string {
  const ending = `-${suffix}`;
  return `${base.slice(0, 64 - ending.length).replace(/-+$/g, '')}${ending}`;
}
