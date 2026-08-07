// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { ContractSourcePinSchema, type RepoVersionSummary } from '@ignite/api';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ArtifactPicker, {
  pinForRepoVersion,
  repoChoicesFor,
} from '../ArtifactPicker';
import { artifactListReceived, compilerReducer } from '../../store/features/compiler/compilerSlice';
import { profilesReducer } from '../../store/features/profiles/profilesSlice';
import { repositoriesReducer, setRepositories } from '../../store/features/repositories/repositoriesSlice';

describe('ArtifactPicker version pins', () => {
  it('renders compiling, contracts, and Retry from artifact and repo states', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ getContext: () => null }) },
    });
    try {
    const makeStore = () => configureStore({
      reducer: { compiler: compilerReducer, profiles: profilesReducer, repositories: repositoriesReducer },
    });
    const list = {
      session: null,
      local: [{ pathOrUrl: '/repo', initialized: true, frameworks: [{ id: 'foundry', name: 'Foundry' }], versions: [] }],
      cloned: [], versionGroups: [], pinned: [],
    };
    const render = (store: ReturnType<typeof makeStore>) => renderToStaticMarkup(
      createElement(
        Provider,
        {
          store,
          children: createElement(ArtifactPicker, {
            value: { id: 'selected', repoPathOrUrl: '/repo', frameworkId: 'foundry', artifactPath: '', contractName: '', sourcePath: '' } as never,
            onSelect: () => undefined,
          }),
        }
      )
    );
    const waiting = makeStore();
    waiting.dispatch(setRepositories(list));
    waiting.dispatch(artifactListReceived({ repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' } }));
    expect(render(waiting)).toContain('Compiling contracts');

    const ready = makeStore();
    ready.dispatch(setRepositories(list));
    ready.dispatch(artifactListReceived({ repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'ready', artifacts: [{ contractName: 'Counter', sourcePath: 'src/Counter.sol', artifactPath: 'out/Counter.json' }] } }));
    expect(render(ready)).toContain('Counter');

    const failed = makeStore();
    failed.dispatch(setRepositories({ ...list, local: [{ ...list.local[0], lastError: { code: 'COMPILE_FAILED', message: 'compile failed', at: '2026-07-22T00:00:00.000Z' } }] }));
    expect(render(failed)).toContain('Retry');
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('carries a tag refKind into a schema-valid source pin', () => {
    const version: RepoVersionSummary = {
      url: 'https://example.test/contracts.git',
      commit: 'a'.repeat(40),
      refLabel: 'v1.2.3',
      refKind: 'tag',
      lastUsedAt: '2026-07-18T00:00:00.000Z',
    };

    expect(ContractSourcePinSchema.parse(pinForRepoVersion(version))).toEqual({
      url: version.url,
      commit: version.commit,
      ref: version.refLabel,
      refKind: 'tag',
    });
  });
});

describe('repoChoicesFor', () => {
  it('offers the session workspace as a first-class repository', () => {
    // In a fresh setup the workspace is often the ONLY repo — without it the
    // picker renders "No options found" and the factory flow dead-ends.
    const choices = repoChoicesFor({
      session: { pathOrUrl: '/workspace', initialized: true, frameworks: [], versions: [] },
      local: [], cloned: [], versionGroups: [], pinned: [],
    } as never);
    expect(choices[0]).toMatchObject({ value: 'live:/workspace', path: '/workspace' });
    // The workspace is a filesystem checkout: its "new version" flow must
    // treat it as local.
    expect(choices.find((choice) => choice.newVersion && choice.path === '/workspace')).toMatchObject({ local: true });
  });

  it('does not duplicate a session that is also attached as local', () => {
    const entry = { pathOrUrl: '/repo', initialized: true, frameworks: [], versions: [] };
    const choices = repoChoicesFor({
      session: entry, local: [entry], cloned: [], versionGroups: [], pinned: [],
    } as never);
    expect(choices.filter((choice) => choice.value === 'live:/repo')).toHaveLength(1);
  });
});
