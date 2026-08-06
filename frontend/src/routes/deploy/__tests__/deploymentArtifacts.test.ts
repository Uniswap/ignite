// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactData } from '@ignite/api';
import type { DraftContract } from '../../../store/features/deployments/types';
import {
  artifactGenerationByCompiler,
  DeploymentArtifactCache,
  deploymentArtifactIdentity,
} from '../useDeploymentArtifacts';

const repoContract: DraftContract = {
  id: 'counter',
  repoPathOrUrl: '/workspace/contracts',
  frameworkId: 'foundry',
  artifactPath: 'out/Counter.sol/Counter.json',
  contractName: 'Counter',
  sourcePath: 'src/Counter.sol',
};

const artifact = {
  abi: [],
  creationCode: '0x6000',
} as unknown as ArtifactData;

describe('deployment artifact identity', () => {
  it('invalidates repo artifacts when their source or local compilation changes', () => {
    const base = deploymentArtifactIdentity(repoContract, 'compile-1');
    expect(deploymentArtifactIdentity(repoContract, 'compile-2')).not.toBe(
      base
    );
    expect(
      deploymentArtifactIdentity(
        { ...repoContract, artifactPath: 'out/Counter.json' },
        'compile-1'
      )
    ).not.toBe(base);
    expect(
      deploymentArtifactIdentity(
        {
          ...repoContract,
          pin: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) },
        },
        'compile-1'
      )
    ).not.toBe(base);
  });

  it('keys contract-type artifacts by their content hash', () => {
    const contract: DraftContract = {
      id: 'proxy',
      origin: 'contract-type',
      contractName: 'Proxy',
      pluginId: 'oz-transparent',
      artifactKey: 'proxy',
      versionLabel: '1.0.0',
      contentHash: 'a'.repeat(64),
    };
    expect(
      deploymentArtifactIdentity({ ...contract, contentHash: 'b'.repeat(64) })
    ).not.toBe(deploymentArtifactIdentity(contract));
  });
});

describe('artifactGenerationByCompiler', () => {
  it('tracks only successful compile-producing jobs', () => {
    const generations = artifactGenerationByCompiler({
      compile: {
        id: 'compile-job',
        type: 'compiler.compile',
        state: 'succeeded',
        params: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry' },
      },
      failed: {
        id: 'failed-job',
        type: 'compiler.compile',
        state: 'failed',
        params: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry' },
      },
      lifecycle: {
        id: 'lifecycle-job',
        type: 'repo.lifecycle',
        state: 'succeeded',
        params: { pathOrUrl: '/workspace/contracts' },
      },
    });
    expect(Object.values(generations)).toEqual(
      expect.arrayContaining(['compile-job', 'lifecycle-job'])
    );
    expect(JSON.stringify(generations)).not.toContain('failed-job');
  });
});

describe('DeploymentArtifactCache', () => {
  it('shares in-flight work and reuses the resolved artifact', async () => {
    let resolve!: (value: ArtifactData) => void;
    const fetcher = vi
      .fn<() => Promise<ArtifactData>>()
      .mockImplementationOnce(
        () => new Promise<ArtifactData>((done) => (resolve = done))
      )
      .mockResolvedValue(artifact);
    const cache = new DeploymentArtifactCache(fetcher);
    const identity = deploymentArtifactIdentity(repoContract);

    const first = cache.load(identity, repoContract);
    const second = cache.load(identity, repoContract);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    resolve(artifact);
    await expect(first).resolves.toBe(artifact);
    await expect(cache.load(identity, repoContract)).resolves.toBe(artifact);
    expect(fetcher).toHaveBeenCalledTimes(1);

    cache.invalidate(identity);
    await cache.load(identity, repoContract);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
