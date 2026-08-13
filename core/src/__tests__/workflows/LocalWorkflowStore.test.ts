import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkflowStore } from '../../workflows/LocalWorkflowStore.js';

const dirs: string[] = [];
const document = {
  schemaVersion: 1 as const,
  sources: [{ id: 'contract', repo: { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/Contract.sol', contractName: 'Contract', artifactPath: 'out/Contract.json' }],
  steps: [{ id: 'deploy', kind: 'deploy' as const, contractId: 'contract' }],
  requiredPlugins: [{ id: 'foundry', version: '1.0.0' }],
  outputs: { hooks: [] },
};

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('LocalWorkflowStore', () => {
  it('stores current documents in a profile-scoped local directory and enforces hashes on updates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-local-workflows-')); dirs.push(root);
    const store = new LocalWorkflowStore({ fileSystem: { getProfileLocalWorkflowsPath: (profileId) => path.join(root, 'profiles', profileId, 'workflows', 'local') }, devMode: () => false });
    const hash = await store.write('profile-a', 'release', document);
    expect(await store.list('profile-a')).toMatchObject({ truncated: false, workflows: [{ name: 'release', valid: true, sourceCount: 1, stepCount: 1 }] });
    expect((await store.list('profile-b')).workflows).toEqual([]);
    const read = await store.read('profile-a', 'release');
    expect(read.docHash).toBe(hash);
    await expect(store.write('profile-a', 'release', document)).rejects.toMatchObject({ code: 'WORKFLOW_BASE_HASH_REQUIRED' });
    await expect(store.write('profile-a', 'release', document, 'b'.repeat(64))).rejects.toMatchObject({ code: 'WORKFLOW_DOC_CONFLICT' });
    await expect(store.write('profile-a', 'release', document, hash)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.stat(path.join(root, 'profiles', 'profile-a', 'workflows', 'local', 'release.json'))).toBeDefined();
  });

  it('rejects Windows reserved device names for local workflows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-local-workflows-')); dirs.push(root);
    const store = new LocalWorkflowStore({ fileSystem: { getProfileLocalWorkflowsPath: (profileId) => path.join(root, 'profiles', profileId, 'workflows', 'local') }, devMode: () => false });

    for (const name of ['con', 'PRN', 'aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9'])
      await expect(store.write('profile-a', name, document)).rejects.toMatchObject({ code: 'WORKFLOW_NAME_INVALID', message: 'Local workflow name cannot be a Windows reserved device name' });
  });
});
