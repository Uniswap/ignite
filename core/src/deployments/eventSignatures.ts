import type { Hex32 } from '@ignite/api';

const cache = new Map<Hex32, string | undefined>();
const TIMEOUT_MS = 2_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function lookupEventSignature(
  topic0: Hex32,
  fetcher: Fetch = fetch,
): Promise<string | undefined> {
  const cached = cache.get(topic0);
  if (cached !== undefined || cache.has(topic0)) return cached;
  try {
    const response = await fetcher(
      `https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${encodeURIComponent(topic0)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return undefined;
    const body = await response.json() as { results?: Array<{ text_signature?: unknown }> };
    const signature = body.results?.find(
      (entry): entry is { text_signature: string } => typeof entry.text_signature === 'string' && entry.text_signature.length > 0,
    )?.text_signature;
    cache.set(topic0, signature);
    return signature;
  } catch {
    // Signature lookup is an optional display enhancement. Network failures
    // must leave callers with their raw log fallback, not block a review.
    return undefined;
  }
}

export function clearEventSignatureCache(): void {
  cache.clear();
}
