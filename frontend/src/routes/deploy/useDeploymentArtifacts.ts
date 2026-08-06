import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactData } from '@ignite/api';
import { ApiError } from '@ignite/api/client';
import { useAppSelector } from '../../store';
import { apiClient } from '../../store/api/client';
import type { JobView } from '../../store/features/jobs/jobsSlice';
import type { DraftContract } from '../../store/features/deployments/types';

export type DeploymentArtifactEntry =
  | { identity: string; status: 'loading' }
  | { identity: string; status: 'ready'; artifact: ArtifactData }
  | { identity: string; status: 'error'; message: string };

type ArtifactFetcher = (contract: DraftContract) => Promise<ArtifactData>;

const compilerGenerationKey = (pathOrUrl: string, pluginId: string) =>
  JSON.stringify([pathOrUrl, pluginId]);
const repositoryGenerationKey = (pathOrUrl: string) =>
  JSON.stringify([pathOrUrl, '*']);

export function artifactGenerationByCompiler(
  jobs: Record<string, Pick<JobView, 'id' | 'type' | 'params' | 'state'>>
): Record<string, string> {
  const jobIds = new Map<string, string[]>();
  for (const job of Object.values(jobs)) {
    if (job.state !== 'succeeded') continue;
    const pathOrUrl = job.params.pathOrUrl;
    if (typeof pathOrUrl !== 'string') continue;
    let key: string | undefined;
    if (
      job.type === 'compiler.compile' &&
      typeof job.params.pluginId === 'string'
    ) {
      key = compilerGenerationKey(pathOrUrl, job.params.pluginId);
    } else if (job.type === 'repo.lifecycle') {
      key = repositoryGenerationKey(pathOrUrl);
    }
    if (key) jobIds.set(key, [...(jobIds.get(key) ?? []), job.id]);
  }
  return Object.fromEntries(
    [...jobIds].map(([key, ids]) => [key, ids.sort().join(',')])
  );
}

function localArtifactGeneration(
  contract: DraftContract,
  generations: Record<string, string>
): string | undefined {
  if (contract.origin === 'contract-type' || contract.pin) return undefined;
  return [
    generations[
      compilerGenerationKey(contract.repoPathOrUrl, contract.frameworkId)
    ],
    generations[repositoryGenerationKey(contract.repoPathOrUrl)],
  ]
    .filter(Boolean)
    .join('|');
}

export function deploymentArtifactIdentity(
  contract: DraftContract,
  localGeneration?: string
): string {
  if (contract.origin === 'contract-type') {
    return JSON.stringify([
      'contract-type',
      contract.pluginId,
      contract.artifactKey,
      contract.contentHash,
    ]);
  }
  return JSON.stringify([
    'repo',
    contract.repoPathOrUrl,
    contract.frameworkId,
    contract.artifactPath,
    contract.pin?.url,
    contract.pin?.commit,
    contract.pin?.ref,
    contract.pin?.refKind,
    contract.pin ? undefined : localGeneration,
  ]);
}

async function fetchDeploymentArtifact(
  contract: DraftContract
): Promise<ArtifactData> {
  if (contract.origin === 'contract-type') {
    const response = await apiClient.request('getContractTypeArtifact', {
      params: {
        pluginId: contract.pluginId,
        artifactKey: contract.artifactKey,
      },
    });
    if (!('data' in response)) throw new Error(response.message);
    return response.data.artifact as unknown as ArtifactData;
  }
  const response = await apiClient.request('getArtifactData', {
    body: {
      pathOrUrl: contract.repoPathOrUrl,
      pluginId: contract.frameworkId,
      artifactPath: contract.artifactPath,
      ...(contract.pin ? { pin: contract.pin } : {}),
    },
  });
  if (!('data' in response)) throw new Error(response.message);
  return response.data;
}

export class DeploymentArtifactCache {
  private readonly resolved = new Map<string, ArtifactData>();
  private readonly inFlight = new Map<string, Promise<ArtifactData>>();

  constructor(
    private readonly fetcher: ArtifactFetcher = fetchDeploymentArtifact
  ) {}

  load(identity: string, contract: DraftContract): Promise<ArtifactData> {
    const cached = this.resolved.get(identity);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(identity);
    if (pending) return pending;
    const request = this.fetcher(contract)
      .then((artifact) => {
        this.resolved.set(identity, artifact);
        return artifact;
      })
      .finally(() => {
        if (this.inFlight.get(identity) === request) {
          this.inFlight.delete(identity);
        }
      });
    this.inFlight.set(identity, request);
    return request;
  }

  invalidate(identity: string): void {
    this.resolved.delete(identity);
  }
}

function artifactErrorMessage(reason: unknown): string {
  if (reason instanceof ApiError) {
    return reason.body.message ?? reason.message;
  }
  return reason instanceof Error ? reason.message : String(reason);
}

export function useDeploymentArtifacts(contracts: DraftContract[]) {
  const jobs = useAppSelector((state) => state.jobs.byId);
  const generations = useMemo(() => artifactGenerationByCompiler(jobs), [jobs]);
  const cache = useRef(new DeploymentArtifactCache()).current;
  const identities = useMemo(
    () =>
      Object.fromEntries(
        contracts.map((contract) => [
          contract.id,
          deploymentArtifactIdentity(
            contract,
            localArtifactGeneration(contract, generations)
          ),
        ])
      ),
    [contracts, generations]
  );
  const identitiesRef = useRef(identities);
  const contractsRef = useRef(contracts);
  const entriesRef = useRef<Record<string, DeploymentArtifactEntry>>({});
  const [entries, setEntries] = useState<
    Record<string, DeploymentArtifactEntry>
  >({});

  const updateEntries = useCallback(
    (
      update: (
        current: Record<string, DeploymentArtifactEntry>
      ) => Record<string, DeploymentArtifactEntry>
    ) => {
      setEntries((current) => {
        const next = update(current);
        entriesRef.current = next;
        return next;
      });
    },
    []
  );

  const settle = useCallback(
    (
      identity: string,
      result:
        | { status: 'ready'; artifact: ArtifactData }
        | { status: 'error'; message: string }
    ) => {
      updateEntries((current) => {
        const next = { ...current };
        for (const [contractId, currentIdentity] of Object.entries(
          identitiesRef.current
        )) {
          if (
            currentIdentity === identity &&
            current[contractId]?.identity === identity
          ) {
            next[contractId] = { identity, ...result };
          }
        }
        return next;
      });
    },
    [updateEntries]
  );

  const load = useCallback(
    (identity: string, contract: DraftContract) => {
      void cache
        .load(identity, contract)
        .then((artifact) => settle(identity, { status: 'ready', artifact }))
        .catch((reason: unknown) =>
          settle(identity, {
            status: 'error',
            message: artifactErrorMessage(reason),
          })
        );
    },
    [cache, settle]
  );

  useEffect(() => {
    identitiesRef.current = identities;
    contractsRef.current = contracts;
    const loads = new Map<string, DraftContract>();
    const next: Record<string, DeploymentArtifactEntry> = {};
    for (const contract of contracts) {
      const identity = identities[contract.id];
      const existing = entriesRef.current[contract.id];
      if (existing?.identity === identity) {
        next[contract.id] = existing;
      } else {
        next[contract.id] = { identity, status: 'loading' };
        loads.set(identity, contract);
      }
    }
    entriesRef.current = next;
    setEntries(next);
    for (const [identity, contract] of loads) load(identity, contract);
  }, [contracts, identities, load]);

  const retry = useCallback(
    (contractId: string) => {
      const identity = identitiesRef.current[contractId];
      const contract = contractsRef.current.find(
        (item) => item.id === contractId
      );
      if (!identity || !contract) return;
      cache.invalidate(identity);
      updateEntries((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, entry]) => [
            id,
            entry.identity === identity
              ? { identity, status: 'loading' }
              : entry,
          ])
        )
      );
      load(identity, contract);
    },
    [cache, load, updateEntries]
  );

  const artifacts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(entries).flatMap(([contractId, entry]) =>
          entry.status === 'ready' ? [[contractId, entry.artifact]] : []
        )
      ) as Record<string, ArtifactData>,
    [entries]
  );

  return { entries, artifacts, retry };
}
