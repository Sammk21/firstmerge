// ---------------------------------------------------------------------------
// Aggressive cache layer.
//
// Two backends, same interface:
//   - Redis  (when REDIS_URL is set and `ioredis` is installed) — shared,
//     survives across processes/deploys, ideal in production.
//   - In-memory (default) — zero setup, keeps the app FREE to run. Per-process,
//     but perfectly fine for a single VPS.
//
// The app code never cares which backend is active. Everything goes through
// getOrSet(), so reads are served from cache and only fall through to SQLite /
// GitHub on a miss. invalidatePrefix() lets the ingest job blow away stale
// list/stats entries the moment fresh data lands.
// ---------------------------------------------------------------------------

const NS = "fm:"; // key namespace, so we can flush only our keys

interface Backend {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, ttlSec: number): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
}

// ----- in-memory backend (default, free) -----------------------------------

class MemoryBackend implements Backend {
  private store = new Map<string, { val: string; expires: number }>();

  async get(key: string) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.val;
  }

  async set(key: string, val: string, ttlSec: number) {
    this.store.set(key, { val, expires: Date.now() + ttlSec * 1000 });
    // opportunistic cleanup so the map can't grow unbounded
    if (this.store.size > 5000) {
      const now = Date.now();
      for (const [k, v] of this.store) if (v.expires < now) this.store.delete(k);
    }
  }

  async delPrefix(prefix: string) {
    for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
  }
}

// ----- redis backend (optional) --------------------------------------------

class RedisBackend implements Backend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private client: any) {}

  async get(key: string) {
    return (await this.client.get(key)) as string | null;
  }

  async set(key: string, val: string, ttlSec: number) {
    await this.client.set(key, val, "EX", ttlSec);
  }

  async delPrefix(prefix: string) {
    // SCAN + UNLINK so we never block Redis on a big KEYS sweep
    let cursor = "0";
    do {
      const [next, keys]: [string, string[]] = await this.client.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        200
      );
      cursor = next;
      if (keys.length) await this.client.unlink(...keys);
    } while (cursor !== "0");
  }
}

// ----- backend selection (lazy, memoized) ----------------------------------

let backendPromise: Promise<Backend> | null = null;

async function backend(): Promise<Backend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if (!process.env.REDIS_URL) return new MemoryBackend();
    try {
      // Variable specifier keeps bundlers from hard-requiring ioredis when it
      // isn't installed — it's an optional dependency.
      const pkg = "ioredis";
      const mod = await import(pkg);
      const Redis = mod.default ?? mod;
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      client.on("error", (e: Error) => {
        // Never let a Redis blip take down a request — log and lean on misses.
        console.warn("[cache] redis error:", e.message);
      });
      console.log("[cache] using Redis");
      return new RedisBackend(client);
    } catch (e) {
      console.warn("[cache] Redis unavailable, using in-memory:", (e as Error).message);
      return new MemoryBackend();
    }
  })();
  return backendPromise;
}

// ----- public API ----------------------------------------------------------

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await (await backend()).get(NS + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // cache must never throw into the request path
  }
}

export async function cacheSet(key: string, val: unknown, ttlSec: number): Promise<void> {
  try {
    await (await backend()).set(NS + key, JSON.stringify(val), ttlSec);
  } catch {
    /* swallow */
  }
}

/** Read-through: serve from cache, else run fn(), cache it, return it. */
export async function getOrSet<T>(key: string, ttlSec: number, fn: () => Promise<T> | T): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  const fresh = await fn();
  // don't cache empty/undefined results aggressively — lets the next call retry
  if (fresh !== undefined && fresh !== null) await cacheSet(key, fresh, ttlSec);
  return fresh;
}

/** Flush every key under a prefix (e.g. after an ingest run). */
export async function invalidatePrefix(prefix: string): Promise<void> {
  try {
    await (await backend()).delPrefix(NS + prefix);
  } catch {
    /* swallow */
  }
}

// Sensible default TTLs (seconds). Tune freely.
export const TTL = {
  issueList: 120, // list/search results — refreshed often, cheap to recompute
  languages: 3600, // language facets barely change
  stats: 120,
  repoSignals: 6 * 3600, // GitHub repo+PR data — expensive, changes slowly
};
