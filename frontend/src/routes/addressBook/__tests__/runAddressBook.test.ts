// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@ignite/api';
import {
  addressBookCandidatesFromRun,
  candidateConflicts,
  mergeRunCandidate,
  slugAddressBookName,
} from '../runAddressBook';

describe('run address book generation', () => {
  it('slugifies names, auto-suffixes duplicates, and collapses only identical addresses', () => {
    const one = '0x1111111111111111111111111111111111111111' as const;
    const two = '0x2222222222222222222222222222222222222222' as const;
    const run = {
      plan: {
        chains: [1, 10],
        contracts: [
          { id: 'a', contractName: 'My Token' },
          { id: 'b', contractName: 'My Token' },
        ],
        steps: [
          { id: 'deploy-a', kind: 'deploy', contractId: 'a' },
          { id: 'deploy-b', kind: 'deploy', contractId: 'b' },
        ],
      },
      lanes: {
        '1': {
          steps: [
            {
              stepId: 'deploy-a',
              status: 'confirmed',
              address: one,
              attempts: [],
            },
            {
              stepId: 'deploy-b',
              status: 'confirmed',
              address: one,
              attempts: [],
            },
          ],
        },
        '10': {
          steps: [
            {
              stepId: 'deploy-a',
              status: 'skipped',
              address: one,
              attempts: [{ resolution: 'accept-deployed' }],
            },
            {
              stepId: 'deploy-b',
              status: 'confirmed',
              address: two,
              attempts: [],
            },
          ],
        },
      },
    } as unknown as RunRecord;

    expect(addressBookCandidatesFromRun(run)).toMatchObject([
      { name: 'my-token', entry: { name: 'my-token', address: one } },
      {
        name: 'my-token-2',
        entry: { name: 'my-token-2', perChain: { '1': one, '10': two } },
      },
    ]);
    expect(slugAddressBookName('  Wrapped / Proxy!!! ')).toBe('wrapped-proxy');
  });

  it('shows per-chain collisions and applies keep or replace while adding missing chains', () => {
    const current = '0x1111111111111111111111111111111111111111' as const;
    const incoming = '0x2222222222222222222222222222222222222222' as const;
    const candidate = {
      stepId: 'deploy',
      name: 'token',
      entry: { name: 'token', perChain: { '1': incoming, '10': incoming } },
      resolutions: { '1': incoming, '10': incoming },
    };
    const existing = { name: 'token', perChain: { '1': current } };
    expect(candidateConflicts(existing, candidate)).toEqual([
      { chainId: '1', current, incoming },
    ]);
    expect(mergeRunCandidate(existing, candidate, new Set())).toEqual({
      name: 'token',
      perChain: { '1': current, '10': incoming },
    });
    expect(mergeRunCandidate(existing, candidate, new Set(['1']))).toEqual({
      name: 'token',
      perChain: { '1': incoming, '10': incoming },
    });
  });
});
