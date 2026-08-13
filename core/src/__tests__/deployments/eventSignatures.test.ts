import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEventSignatureCache, lookupEventSignature } from '../../deployments/eventSignatures.js';

const TOPIC = `0x${'11'.repeat(32)}` as `0x${string}`;

describe('event signature lookup', () => {
  afterEach(() => clearEventSignatureCache());

  it('caches a 4byte event signature result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      results: [{ text_signature: 'Transferred(address,address,uint256)' }],
    }), { status: 200 }));
    await expect(lookupEventSignature(TOPIC, fetcher)).resolves.toBe('Transferred(address,address,uint256)');
    await expect(lookupEventSignature(TOPIC, fetcher)).resolves.toBe('Transferred(address,address,uint256)');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('tolerates lookup failures', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    await expect(lookupEventSignature(TOPIC, fetcher)).resolves.toBeUndefined();
    await expect(lookupEventSignature(TOPIC, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent lookups for the same topic', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const first = lookupEventSignature(TOPIC, fetcher);
    const second = lookupEventSignature(TOPIC, fetcher);
    resolve(new Response(JSON.stringify({ results: [{ text_signature: 'Ping(uint256)' }] }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual(['Ping(uint256)', 'Ping(uint256)']);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
