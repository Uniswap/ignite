// The migration's structural guarantee: no factory-identity control flow
// survives in core. Factory is one call-products plugin among many; any
// reappearing `kind: 'factory'` branch, strategy guard, or fulfilledBy edge
// would mean core regained a first-party capability advantage.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The retired representation, as identity patterns rather than the bare word:
// strategy discriminator, classifier helper, and the old producer edge.
const IDENTITY = /kind:\s*['"]factory['"]|isFactoryStrategy|fulfilledBy/;
// Known homonyms: files allowed to say "factory" for unrelated reasons
// (factory reset, the CREATE2 proxy-as-factory notes, TJAR heuristics in
// verification arg guessing) or in prose explaining the produced model.
const HOMONYMS = new Set([
  'api/plugins/trust.ts',
  'api/system.ts',
  'deployments/DeployEngine.ts',
  'deployments/contractTypeValidation.ts',
  'deployments/produced.ts',
  'jobs/JobManager.ts',
  'repos/RepoLifecycle.ts',
  'system/factoryReset.ts',
  'types/errors.ts',
  'verifications/guessArgs.ts',
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('factory identity is gone from core source', () => {
  const files = sourceFiles(SRC).map((file) => ({
    relative: path.relative(SRC, file).split(path.sep).join('/'),
    content: fs.readFileSync(file, 'utf8'),
  }));

  it('scans a plausible tree', () => {
    // Guards the scan itself: if the walk breaks, the assertions below would
    // pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.relative === 'deployments/produced.ts')).toBe(true);
  });

  it('contains no factory-identity control flow', () => {
    const offenders = files
      .filter((file) => IDENTITY.test(file.content))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });

  it('mentions the word factory only in the known homonym files', () => {
    const offenders = files
      .filter((file) => /factory/i.test(file.content) && !HOMONYMS.has(file.relative))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });
});
