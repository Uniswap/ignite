// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { parseAddSignerValue, signerAddOptions } from '../steps/SignersStep';

const providers = [
  { pluginId: 'browser-wallet', name: 'Browser Wallet' },
  { pluginId: 'mnemonic', name: 'Mnemonic' },
  { pluginId: 'private-key', name: 'Private Key' },
];

describe('signer wizard add options', () => {
  // Key-based providers are configured, not connected: their accounts come
  // from vault entries, so the dropdown offers a persistent add row for each.
  // Frontend-runtime providers (browser wallet) connect via the cards above
  // the dropdown instead, so they must not get an add row.
  it('offers an add row per container provider but not for runtime wallets', () => {
    expect(signerAddOptions(providers, ['browser-wallet'])).toEqual([
      { value: '__add__:mnemonic', label: '+ Add Mnemonic…' },
      { value: '__add__:private-key', label: '+ Add Private Key…' },
    ]);
  });

  it('keeps add rows before the runtime plugin list has loaded', () => {
    // The runtime host loads asynchronously; an empty id list must not hide
    // the container providers' add rows.
    const labels = signerAddOptions(providers, []).map(
      (option) => option.label
    );
    expect(labels).toContain('+ Add Private Key…');
    expect(labels).toContain('+ Add Mnemonic…');
  });

  it('parses add sentinels and rejects real account values', () => {
    expect(parseAddSignerValue('__add__:private-key')).toBe('private-key');
    // Real refs are `${pluginId}:${accountId}` — never an add action, even
    // though they also contain a colon.
    expect(parseAddSignerValue('private-key:acct0')).toBeUndefined();
    expect(parseAddSignerValue('__none__')).toBeUndefined();
  });
});
