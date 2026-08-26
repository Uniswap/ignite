// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node builtins are supplied by the repository test command via npx.
import { readdirSync, readFileSync, statSync } from 'node:fs';
// @ts-expect-error Node builtins are supplied by the repository test command via npx.
import { dirname, join } from 'node:path';
// @ts-expect-error Node builtins are supplied by the repository test command via npx.
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The whole deploy feature: wizard, step cards, draft slice/persistence, and
// the run/pause surfaces where the first-class strategy used to branch.
const roots = [
  join(here, '..'),
  join(here, '..', '..', 'deployments'),
  join(here, '..', '..', '..', 'store', 'features', 'deployments'),
];

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name: string) => {
    const path = join(root, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('factory surface removal', () => {
  it('leaves no factory identifier or branch in the deploy feature sources', () => {
    // The migration's success criterion is structural: produced mode is
    // reached only through the generic plugin strategy, never through a
    // deployment-type identity check. Any hit here is a regression.
    const hits = roots.flatMap((root) =>
      sourceFiles(root).flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return /factor(y|ies)/i.test(source) ? [path] : [];
      })
    );
    expect(hits).toEqual([]);
  });
});
