// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { findVersionForPin, pinChipText, pinVersionLabel } from '../pinDisplay';

const pin = {
  url: 'https://github.com/Uniswap/tjar',
  commit: '3cbfd28e76c5aaaabbbbccccddddeeeeffff0000',
};
const short = '3cbfd28e76c5';

describe('pin version chip', () => {
  it('shows the version record label alongside the commit', () => {
    expect(pinChipText(pin, { ...pin, refLabel: 'oz-audit-final' })).toBe(
      `oz-audit-final · ${short}`
    );
  });

  // Regression: the chip rendered `pin.ref ?? shortCommit` followed by the
  // short commit, so an unlabelled pin printed the commit twice.
  it('shows the commit once when no label is known', () => {
    expect(pinChipText(pin)).toBe(short);
    expect(pinChipText(pin, { ...pin })).toBe(short);
  });

  it('falls back to the pin ref when no version record is loaded', () => {
    expect(pinChipText({ ...pin, ref: 'oz-audit-final' })).toBe(
      `oz-audit-final · ${short}`
    );
  });

  it('prefers the version record label over a stale pin ref', () => {
    expect(
      pinChipText({ ...pin, ref: 'old-tag' }, { ...pin, refLabel: 'v2' })
    ).toBe(`v2 · ${short}`);
  });

  // A pin whose ref is the commit itself must not reintroduce the duplicate.
  it('does not repeat the commit when the label is the commit', () => {
    expect(pinChipText({ ...pin, ref: short })).toBe(short);
    expect(pinChipText({ ...pin, ref: pin.commit })).toBe(short);
  });

  it('treats a blank label as absent', () => {
    expect(pinChipText({ ...pin, ref: '   ' })).toBe(short);
    expect(pinVersionLabel({ ...pin, ref: '' })).toBeUndefined();
  });
});

describe('finding the version record for a pin', () => {
  const version = { ...pin, refLabel: 'oz-audit-final' };

  it('looks through version groups, local, cloned and session entries', () => {
    const inGroups = { versionGroups: [{ url: pin.url, versions: [version] }] };
    const inLocal = { local: [{ versions: [version] }] };
    const inCloned = { cloned: [{ versions: [version] }] };
    const inSession = { session: { versions: [version] } };
    for (const repositories of [inGroups, inLocal, inCloned, inSession]) {
      expect(findVersionForPin(repositories, pin)?.refLabel).toBe(
        'oz-audit-final'
      );
    }
  });

  it('matches on both url and commit, not either alone', () => {
    const repositories = { local: [{ versions: [version] }] };
    expect(
      findVersionForPin(repositories, { ...pin, commit: 'f'.repeat(40) })
    ).toBeUndefined();
    expect(
      findVersionForPin(repositories, {
        ...pin,
        url: 'https://github.com/other/repo',
      })
    ).toBeUndefined();
  });

  // The repositories slice is null until its first load.
  it('is safe when repositories or the pin are missing', () => {
    expect(findVersionForPin(undefined, pin)).toBeUndefined();
    expect(findVersionForPin(null, pin)).toBeUndefined();
    expect(findVersionForPin({}, pin)).toBeUndefined();
    expect(
      findVersionForPin({ local: [{ versions: [version] }] }, undefined)
    ).toBeUndefined();
  });
});
