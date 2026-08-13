// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { initcodeHashForEntry } from '../steps/ContractsStep';
import type { DeploymentArtifactEntry } from '../useDeploymentArtifacts';

const CREATION_CODE = '0x6080604052';

function readyEntry(
  overrides: Partial<
    Extract<DeploymentArtifactEntry, { status: 'ready' }>['artifact']
  > = {}
): DeploymentArtifactEntry {
  return {
    identity: 'contract-1',
    status: 'ready',
    artifact: {
      solidityVersion: '0.8.30',
      optimizer: false,
      optimizerRuns: 200,
      viaIR: false,
      bytecodeHash: 'ipfs',
      abi: [],
      creationCode: CREATION_CODE,
      deployedBytecode: '0x6080',
      ...overrides,
    },
  } as DeploymentArtifactEntry;
}

describe('initcodeHashForEntry', () => {
  it('hashes the creation code of a ready artifact', () => {
    expect(initcodeHashForEntry(readyEntry())).toBe(keccak256(CREATION_CODE));
  });

  it('returns undefined while the artifact is loading or failed', () => {
    expect(initcodeHashForEntry(undefined)).toBeUndefined();
    expect(
      initcodeHashForEntry({
        identity: 'contract-1',
        status: 'loading',
      } as DeploymentArtifactEntry)
    ).toBeUndefined();
    expect(
      initcodeHashForEntry({
        identity: 'contract-1',
        status: 'error',
        message: 'boom',
      } as DeploymentArtifactEntry)
    ).toBeUndefined();
  });

  it('returns undefined for empty creation code', () => {
    expect(
      initcodeHashForEntry(readyEntry({ creationCode: '0x' }))
    ).toBeUndefined();
    expect(
      initcodeHashForEntry(readyEntry({ creationCode: '' }))
    ).toBeUndefined();
  });

  it('returns undefined when the creation code needs library linking', () => {
    expect(
      initcodeHashForEntry(
        readyEntry({
          creationCodeLinkReferences: {
            'src/Lib.sol': { Lib: [{ start: 1, length: 20 }] },
          },
        })
      )
    ).toBeUndefined();
  });

  it('ignores empty link reference sources', () => {
    expect(
      initcodeHashForEntry(
        readyEntry({ creationCodeLinkReferences: { 'src/Lib.sol': {} } })
      )
    ).toBe(keccak256(CREATION_CODE));
  });
});
