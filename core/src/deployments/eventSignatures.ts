import type { Hex32 } from '@ignite/api';

const CACHE_LIMIT = 4_096;
const NEGATIVE_CACHE_TTL_MS = 60_000;
const cache = new Map<Hex32, { signature?: string; expiresAt?: number }>();
const inFlight = new Map<Hex32, Promise<string | undefined>>();
const TIMEOUT_MS = 2_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function lookupEventSignature(
  topic0: Hex32,
  fetcher: Fetch = fetch,
): Promise<string | undefined> {
  const cached = cache.get(topic0);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now()))
    return cached.signature;
  if (cached) cache.delete(topic0);
  const pending = inFlight.get(topic0);
  if (pending) return pending;
  const lookup = (async () => {
    try {
      const response = await fetcher(
        `https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${encodeURIComponent(topic0)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const body = response.ok
        ? await response.json() as { results?: Array<{ text_signature?: unknown }> }
        : undefined;
      const signature = body?.results?.find(
        (entry): entry is { text_signature: string } => typeof entry.text_signature === 'string' && entry.text_signature.length > 0,
      )?.text_signature;
      remember(topic0, signature);
      return signature;
    } catch {
      // Signature lookup is an optional display enhancement. Network failures
      // must leave callers with their raw log fallback, not block a review.
      remember(topic0, undefined);
      return undefined;
    } finally {
      inFlight.delete(topic0);
    }
  })();
  inFlight.set(topic0, lookup);
  return lookup;
}

function remember(topic0: Hex32, signature: string | undefined): void {
  cache.delete(topic0);
  cache.set(topic0, signature === undefined
    ? { expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS }
    : { signature });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as Hex32 | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function clearEventSignatureCache(): void {
  cache.clear();
  inFlight.clear();
}
