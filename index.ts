import type { FrameMasterPlugin } from "frame-master/plugin/types";
import type { masterRequest } from "frame-master/server/request";

// ============================================================================
// Types
// ============================================================================

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

export interface RateLimitStore {
  /** Get or create an entry for the given key */
  get(key: string): RateLimitEntry | undefined;
  /** Set an entry for the given key */
  set(key: string, entry: RateLimitEntry): void;
  /** Delete an entry */
  delete(key: string): void;
  /** Clear all entries */
  clear(): void;
}

export interface RouteLimit {
  /** Glob pattern or regex to match routes */
  pattern: string | RegExp;
  /** Max requests allowed in the window */
  limit: number;
  /** Time window in milliseconds */
  windowMs?: number;
}

export interface RateLimiterOptions {
  /**
   * Maximum requests per window (default: 100)
   */
  limit?: number;

  /**
   * Plugin priority (default: 0)
   */
  priority?: number;

  /**
   * Time window in milliseconds (default: 60000 = 1 minute)
   */
  windowMs?: number;

  /**
   * Function to extract a unique key from the request (default: client IP)
   */
  keyGenerator?: (master: masterRequest) => string;

  /**
   * Custom store for rate limit data (default: in-memory Map)
   */
  store?: RateLimitStore;

  /**
   * Routes to skip rate limiting
   */
  skip?: string[] | ((master: masterRequest) => boolean);

  /**
   * Route-specific limits (overrides default limit for matching routes)
   */
  routeLimits?: RouteLimit[];

  /**
   * Custom response when rate limited
   */
  onRateLimited?: (master: masterRequest, result: RateLimitResult) => void;

  /**
   * Whether to add rate limit headers to responses (default: true)
   */
  headers?: boolean;

  /**
   * Header names customization
   */
  headerNames?: {
    limit?: string;
    remaining?: string;
    reset?: string;
    retryAfter?: string;
  };

  /**
   * Message to return when rate limited (default: "Too Many Requests")
   */
  message?: string | Record<string, unknown>;

  /**
   * Status code when rate limited (default: 429)
   */
  statusCode?: number;
}

// ============================================================================
// Default In-Memory Store
// ============================================================================

class MemoryStore implements RateLimitStore {
  private store = new Map<string, RateLimitEntry>();
  private cleanupInterval: Timer | null = null;

  constructor(windowMs: number) {
    // Cleanup expired entries periodically
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (entry.resetAt <= now) {
          this.store.delete(key);
        }
      }
    }, windowMs);
  }

  get(key: string): RateLimitEntry | undefined {
    return this.store.get(key);
  }

  set(key: string, entry: RateLimitEntry): void {
    this.store.set(key, entry);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// ============================================================================
// Utilities
// ============================================================================

function getClientIP(master: masterRequest): string {
  const request = master.request;

  // Check common proxy headers
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const ip = forwardedFor.split(",").at(0);
    if (!ip) throw new Error("Invalid x-forwarded-for header");
    return ip.trim();
  }

  const realIP = request.headers.get("x-real-ip");
  if (realIP) {
    return realIP;
  }

  // Fallback to connection info from Bun server
  const socketAddress = master.serverInstance.requestIP(request);
  return socketAddress?.address || "unknown";
}

function matchRoute(pathname: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }

  // Use URLPattern for route matching
  const urlPattern = new URLPattern({ pathname: pattern });
  return urlPattern.test({ pathname });
}

// ============================================================================
// Rate Limiter Core
// ============================================================================

class RateLimiter {
  private store: RateLimitStore;
  private ownStore: MemoryStore | null = null;
  private options: Required<
    Omit<
      RateLimiterOptions,
      "store" | "keyGenerator" | "skip" | "routeLimits" | "onRateLimited"
    >
  > & {
    keyGenerator: (master: masterRequest) => string;
    skip?: string[] | ((master: masterRequest) => boolean);
    routeLimits?: RouteLimit[];
    onRateLimited?: (master: masterRequest, result: RateLimitResult) => void;
  };

  constructor(options: RateLimiterOptions = {}) {
    const windowMs = options.windowMs ?? 60_000;

    if (options.store) {
      this.store = options.store;
    } else {
      this.ownStore = new MemoryStore(windowMs);
      this.store = this.ownStore;
    }

    this.options = {
      limit: options.limit ?? 100,
      windowMs,
      keyGenerator: options.keyGenerator ?? getClientIP,
      skip: options.skip,
      routeLimits: options.routeLimits,
      onRateLimited: options.onRateLimited,
      headers: options.headers ?? true,
      headerNames: {
        limit: options.headerNames?.limit ?? "X-RateLimit-Limit",
        remaining: options.headerNames?.remaining ?? "X-RateLimit-Remaining",
        reset: options.headerNames?.reset ?? "X-RateLimit-Reset",
        retryAfter: options.headerNames?.retryAfter ?? "Retry-After",
      },
      message: options.message ?? "Too Many Requests",
      statusCode: options.statusCode ?? 429,
      priority: options.priority ?? 0,
    };
  }

  shouldSkip(master: masterRequest): boolean {
    const { skip } = this.options;

    if (!skip) return false;

    if (typeof skip === "function") {
      return skip(master);
    }

    const pathname = master.URL.pathname;
    return skip.some((pattern) => matchRoute(pathname, pattern));
  }

  getLimitForRoute(pathname: string): {
    limit: number;
    pattern: string | RegExp | null;
  } {
    const { routeLimits, limit } = this.options;

    if (!routeLimits) return { limit, pattern: null };

    for (const routeLimit of routeLimits) {
      if (matchRoute(pathname, routeLimit.pattern)) {
        return { limit: routeLimit.limit, pattern: routeLimit.pattern };
      }
    }

    return { limit, pattern: null };
  }

  getWindowForRoute(pathname: string): number {
    const { routeLimits, windowMs } = this.options;

    if (!routeLimits) return windowMs;

    for (const routeLimit of routeLimits) {
      if (matchRoute(pathname, routeLimit.pattern)) {
        return routeLimit.windowMs ?? windowMs;
      }
    }

    return windowMs;
  }

  check(master: masterRequest): RateLimitResult {
    const baseKey = this.options.keyGenerator(master);
    const pathname = master.URL.pathname;
    const { limit, pattern } = this.getLimitForRoute(pathname);
    const windowMs = this.getWindowForRoute(pathname);
    const now = Date.now();

    // Include route pattern in key for route-specific counters
    const patternKey = pattern ? `:route:${pattern.toString()}` : "";
    const key = `${baseKey}${patternKey}`;

    let entry = this.store.get(key);

    // Create new entry or reset if window expired
    if (!entry || entry.resetAt <= now) {
      entry = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    entry.count++;
    this.store.set(key, entry);

    const remaining = Math.max(0, limit - entry.count);
    const allowed = entry.count <= limit;

    return {
      allowed,
      remaining,
      resetAt: entry.resetAt,
      limit,
    };
  }

  applyHeaders(master: masterRequest, result: RateLimitResult): void {
    if (!this.options.headers) return;

    const { headerNames } = this.options;

    master.setHeader(headerNames.limit!, result.limit.toString());
    master.setHeader(headerNames.remaining!, result.remaining.toString());
    master.setHeader(
      headerNames.reset!,
      Math.ceil(result.resetAt / 1000).toString()
    );

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      master.setHeader(headerNames.retryAfter!, retryAfter.toString());
    }
  }

  handleRateLimited(master: masterRequest, result: RateLimitResult): void {
    if (this.options.onRateLimited) {
      this.options.onRateLimited(master, result);
      return;
    }

    const { message, statusCode } = this.options;
    const body =
      typeof message === "string" ? message : JSON.stringify(message);
    const contentType =
      typeof message === "string" ? "text/plain" : "application/json";

    master.setResponse(body, {
      status: statusCode,
      headers: { "Content-Type": contentType },
    });
    master.sendNow();
  }

  destroy(): void {
    if (this.ownStore) {
      this.ownStore.destroy();
    }
  }

  /**
   * Reset rate limit for a specific key (exact match)
   */
  reset(key: string): void {
    this.store.delete(key);
  }

  /**
   * Reset rate limit for the current request's route
   */
  resetForRequest(master: masterRequest): void {
    const key = this.getFullKeyForRequest(master);
    this.reset(key);
  }

  /**
   * Reset all rate limits for a base key (all routes)
   * Useful when you want to reset limits for all routes for a user/IP
   */
  resetAllForBaseKey(baseKey: string): void {
    // For MemoryStore, we can iterate and delete matching keys
    if (this.ownStore) {
      const store = (this.ownStore as any).store as Map<string, RateLimitEntry>;
      for (const key of store.keys()) {
        if (key === baseKey || key.startsWith(`${baseKey}:route:`)) {
          store.delete(key);
        }
      }
    } else {
      // For custom stores, just delete the base key
      // Custom stores should implement their own prefix-based deletion
      this.store.delete(baseKey);
    }
  }

  /**
   * Reset all rate limits for the current request's base key (all routes)
   */
  resetAllForRequest(master: masterRequest): void {
    const baseKey = this.options.keyGenerator(master);
    this.resetAllForBaseKey(baseKey);
  }

  /**
   * Get the full key (including route pattern) for a request
   */
  getFullKeyForRequest(master: masterRequest): string {
    const baseKey = this.options.keyGenerator(master);
    const pathname = master.URL.pathname;
    const { pattern } = this.getLimitForRoute(pathname);
    const patternKey = pattern ? `:route:${pattern.toString()}` : "";
    return `${baseKey}${patternKey}`;
  }

  /**
   * Get the base key (without route pattern) for a request
   */
  getBaseKeyForRequest(master: masterRequest): string {
    return this.options.keyGenerator(master);
  }
}

// ============================================================================
// Plugin Export
// ============================================================================

/**
 * Frame-Master Rate Limiter Plugin
 *
 * A modular rate limiting plugin with support for:
 * - Configurable request limits and time windows
 * - Route-specific rate limits
 * - Custom key generation (IP, user ID, API key, etc.)
 * - Custom stores (Redis, database, etc.)
 * - Standard rate limit headers
 *
 * @example Basic usage
 * ```typescript
 * import rateLimiter from "frame-master-plugin-rate-limiter";
 *
 * const config: FrameMasterConfig = {
 *   plugins: [
 *     rateLimiter({ limit: 100, windowMs: 60_000 })
 *   ]
 * };
 * ```
 *
 * @example Route-specific limits
 * ```typescript
 * rateLimiter({
 *   limit: 100,
 *   routeLimits: [
 *     { pattern: "/api/auth/**", limit: 5, windowMs: 60_000 },
 *     { pattern: "/api/upload", limit: 10, windowMs: 300_000 },
 *   ],
 *   skip: ["/health", "/static/**"],
 * })
 * ```
 *
 * @example Custom key generator (rate limit by user ID)
 * ```typescript
 * rateLimiter({
 *   keyGenerator: (master) => {
 *     const userId = master.getContext<{ userId?: string }>().userId;
 *     return userId || getClientIP(master);
 *   }
 * })
 * ```
 */
export default function rateLimiter(
  options: RateLimiterOptions = {}
): FrameMasterPlugin {
  let limiter: RateLimiter;

  return {
    name: "frame-master-plugin-rate-limiter",
    version: "0.1.0",
    priority: options.priority ?? 0, // Run early to block requests before processing

    router: {
      before_request: async (master) => {
        // Skip if configured
        if (limiter.shouldSkip(master)) {
          master.setContext({ __rateLimitSkipped: true });
          return;
        }

        // Check rate limit
        const result = limiter.check(master);

        // Apply headers
        limiter.applyHeaders(master, result);

        // Store result in context for the request hook and other plugins
        master.setContext({
          __rateLimitResult: result,
          __rateLimitReset: () => limiter.resetForRequest(master),
          __rateLimitResetAll: () => limiter.resetAllForRequest(master),
          __rateLimitResetByKey: (key: string) => limiter.reset(key),
          __rateLimitKey: limiter.getFullKeyForRequest(master),
          __rateLimitBaseKey: limiter.getBaseKeyForRequest(master),
        });
      },

      request: async (master) => {
        // Check if rate limiting was applied
        const ctx = master.getContext<{
          __rateLimitResult?: RateLimitResult;
          __rateLimitSkipped?: boolean;
        }>();

        if (ctx.__rateLimitSkipped || !ctx.__rateLimitResult) {
          return;
        }

        // Block if rate limited
        if (!ctx.__rateLimitResult.allowed) {
          limiter.handleRateLimited(master, ctx.__rateLimitResult);
        }
      },
    },

    serverStart: {
      main: async () => {
        limiter = new RateLimiter(options);
      },
    },

    requirement: {
      frameMasterVersion: "^3.0.0",
      bunVersion: ">=1.2.0",
    },
  };
}

// Export types and utilities for custom implementations
export { RateLimiter, MemoryStore, getClientIP, matchRoute };

/**
 * Context type for accessing rate limit functions in other plugins
 */
export interface RateLimitContext {
  __rateLimitResult?: RateLimitResult;
  __rateLimitSkipped?: boolean;
  __rateLimitReset?: () => void;
  __rateLimitResetAll?: () => void;
  __rateLimitResetByKey?: (key: string) => void;
  __rateLimitKey?: string;
  __rateLimitBaseKey?: string;
}

/**
 * Reset the rate limit for the current request's route.
 * Call this after successful authentication, captcha completion, etc.
 *
 * @example
 * ```typescript
 * import { resetRateLimit } from "frame-master-plugin-rate-limiter";
 *
 * // In your auth plugin's request handler
 * if (loginSuccessful) {
 *   resetRateLimit(master);
 * }
 * ```
 */
export function resetRateLimit(master: masterRequest): boolean {
  const ctx = master.getContext<RateLimitContext>();
  if (ctx.__rateLimitReset) {
    ctx.__rateLimitReset();
    return true;
  }
  return false;
}

/**
 * Reset all rate limits for the current request (all routes).
 * Useful when you want to reset limits for all routes for the current user/IP.
 *
 * @example
 * ```typescript
 * import { resetAllRateLimits } from "frame-master-plugin-rate-limiter";
 *
 * // Reset all route limits for the current user
 * resetAllRateLimits(master);
 * ```
 */
export function resetAllRateLimits(master: masterRequest): boolean {
  const ctx = master.getContext<RateLimitContext>();
  if (ctx.__rateLimitResetAll) {
    ctx.__rateLimitResetAll();
    return true;
  }
  return false;
}

/**
 * Reset the rate limit for a specific key (exact match).
 * Use the full key including route pattern for route-specific resets.
 *
 * @example
 * ```typescript
 * import { resetRateLimitByKey } from "frame-master-plugin-rate-limiter";
 *
 * // Reset rate limit for a specific route
 * resetRateLimitByKey(master, "ip:192.168.1.1:route:/protected**");
 *
 * // Reset base key (no route pattern)
 * resetRateLimitByKey(master, "ip:192.168.1.1");
 * ```
 */
export function resetRateLimitByKey(
  master: masterRequest,
  key: string
): boolean {
  const ctx = master.getContext<RateLimitContext>();
  if (ctx.__rateLimitResetByKey) {
    ctx.__rateLimitResetByKey(key);
    return true;
  }
  return false;
}

/**
 * Get the full rate limit key for the current request (includes route pattern).
 * Example: "ip:192.168.1.1:route:/protected**"
 */
export function getRateLimitKey(master: masterRequest): string | undefined {
  const ctx = master.getContext<RateLimitContext>();
  return ctx.__rateLimitKey;
}

/**
 * Get the base rate limit key for the current request (without route pattern).
 * Example: "ip:192.168.1.1"
 */
export function getRateLimitBaseKey(master: masterRequest): string | undefined {
  const ctx = master.getContext<RateLimitContext>();
  return ctx.__rateLimitBaseKey;
}
