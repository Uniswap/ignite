import { describe, it, expect, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { ContractSource } from '@ignite/api';
import {
  getCompilerArtifactData,
  type CompilerExecutorLike,
  type CompilerHandlerDeps,
} from '../../api/plugins/compiler/index.js';
import { ErrorCodes } from '../../types/errors.js';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';

const PIN = {
  url: 'https://github.com/Uniswap/tjar',
  commit: 'a'.repeat(40),
  ref: 'oz-audit-final',
  refKind: 'tag' as const,
};

function pinnedContract(): ContractSource {
  return {
    id: 'jar-art',
    repoPathOrUrl: PIN.url,
    frameworkId: 'foundry',
    artifactPath: 'out/TokenJar.sol/TokenJar.json',
    contractName: 'TokenJar',
    sourcePath: 'src/TokenJar.sol',
    pin: PIN,
  };
}

function deps(executor: CompilerExecutorLike) {
  return {
    executor,
    registryLoader: {
      getPluginConfig: vi.fn(async () => ({
        metadata: { types: [PluginType.COMPILER] },
      }) as unknown as PluginConfig),
    },
    repos: {
      withVersionMaterialized: vi.fn(
        async (
          _profileId: string,
          _url: string,
          _commit: string,
          _opts: unknown,
          fn: (materialized: {
            checkout: string;
            rematerialize: () => Promise<{ checkout: string }>;
          }) => Promise<unknown>
        ) =>
          fn({
            checkout: '/cache/versions/aaa',
            rematerialize: async () => ({ checkout: '/cache/versions/aaa' }),
          })
      ),
      resolveExistingWorkspacePath: vi.fn(async (pathOrUrl: string) => pathOrUrl),
    },
  } as unknown as Pick<CompilerHandlerDeps, 'executor' | 'registryLoader' | 'repos'>;
}

function scriptedExecutor(
  script: Array<{ op: string; result: { success: boolean; data?: unknown; error?: { code?: string; message?: string } } }>
): CompilerExecutorLike & { calls: Array<{ op: string; params: unknown; workspacePath?: string }> } {
  const calls: Array<{ op: string; params: unknown; workspacePath?: string }> = [];
  return {
    calls,
    execute: vi.fn(async (_pluginId: string, op: string, params: unknown, opts?: { workspacePath?: string }) => {
      calls.push({ op, params, workspacePath: opts?.workspacePath });
      const next = script.shift();
      if (!next) throw new Error(`unscripted call: ${op}`);
      if (next.op !== op) throw new Error(`expected ${next.op}, got ${op}`);
      return next.result;
    }) as CompilerExecutorLike['execute'],
  };
}

describe('getCompilerArtifactData on a source-only pinned checkout', () => {
  // Rematerialization rebuilds a version checkout from git, so it holds
  // sources but no out/ until something compiles it again — while the picker
  // keeps listing contracts from the fingerprint cache. The data read must
  // recover by compiling in place instead of failing what the listing offered.
  it('compiles the checkout once and rereads the artifact', async () => {
    const executor = scriptedExecutor([
      { op: 'getArtifactData', result: { success: false, error: { code: ErrorCodes.ARTIFACT_NOT_FOUND } } },
      { op: 'compile', result: { success: true } },
      { op: 'getArtifactData', result: { success: true, data: { abi: [] } } },
    ]);

    const data = await getCompilerArtifactData(deps(executor), {
      profileId: 'default',
      contract: pinnedContract(),
    });

    expect(data).toEqual({ abi: [] });
    expect(executor.calls.map((call) => call.op)).toEqual([
      'getArtifactData',
      'compile',
      'getArtifactData',
    ]);
    expect(executor.calls[1].workspacePath).toBe('/cache/versions/aaa');
  });

  it('surfaces the original miss when the on-demand compile fails', async () => {
    const executor = scriptedExecutor([
      { op: 'getArtifactData', result: { success: false, error: { code: ErrorCodes.ARTIFACT_NOT_FOUND } } },
      { op: 'compile', result: { success: false, error: { code: ErrorCodes.COMPILE_FAILED } } },
    ]);

    await expect(
      getCompilerArtifactData(deps(executor), {
        profileId: 'default',
        contract: pinnedContract(),
      })
    ).rejects.toMatchObject({ code: ErrorCodes.ARTIFACT_NOT_FOUND });
  });

  it('never compiles a live workspace on a miss', async () => {
    // Live workspaces are the lifecycle's job; a miss there means a wrong
    // path, which a compile would not fix.
    const executor = scriptedExecutor([
      { op: 'getArtifactData', result: { success: false, error: { code: ErrorCodes.ARTIFACT_NOT_FOUND } } },
    ]);
    const live: ContractSource = {
      id: 'jar-art',
      repoPathOrUrl: '/workspace',
      frameworkId: 'foundry',
      artifactPath: 'out/TokenJar.sol/TokenJar.json',
      contractName: 'TokenJar',
      sourcePath: 'src/TokenJar.sol',
    };

    await expect(
      getCompilerArtifactData(deps(executor), {
        profileId: 'default',
        contract: live,
      })
    ).rejects.toMatchObject({ code: ErrorCodes.ARTIFACT_NOT_FOUND });
    expect(executor.calls.map((call) => call.op)).toEqual(['getArtifactData']);
  });
});
