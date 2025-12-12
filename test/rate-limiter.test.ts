import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import rateLimiter, {
  RateLimiter,
  MemoryStore,
  getClientIP,
  matchRoute,
  resetRateLimit,
  resetAllRateLimits,
  resetRateLimitByKey,
  getRateLimitKey,
  getRateLimitBaseKey,
  type RateLimitStore,
  type RateLimitEntry,
  type RateLimitResult,
  type RateLimiterOptions,
} from "../index";

// ============================================================================
// Mock masterRequest
// ============================================================================

function createMockRequest(
  options: {
    pathname?: string;
    ip?: string;
    headers?: Record<string, string>;
  } = {}
): any {
  const { pathname = "/", ip = "127.0.0.1", headers = {} } = options;

  const context: Record<string, unknown> = {};
  const responseHeaders = new Map<string, string>();
  let response: { body: string; init: ResponseInit } | null = null;
  let sendNowCalled = false;

  return {
    request: {
      headers: {
        get: (name: string) => headers[name.toLowerCase()] || null,
      },
      url: `http://localhost:3000${pathname}`,
    },
    URL: new URL(`http://localhost:3000${pathname}`),
    serverInstance: {
      requestIP: () => ({ address: ip }),
    },
    context,
    getContext: <T = Record<string, unknown>>() => context as T,
    setContext: (ctx: Record<string, unknown>) => {
      Object.assign(context, ctx);
    },
    setHeader: (name: string, value: string) => {
      responseHeaders.set(name, value);
    },
    getResponseHeader: (name: string) => responseHeaders.get(name),
    setResponse: (body: string, init: ResponseInit) => {
      response = { body, init };
    },
    sendNow: () => {
      sendNowCalled = true;
    },
    isResponseSetted: () => response !== null,
    getResponse: () => response,
    isSendNowCalled: () => sendNowCalled,
    getAllHeaders: () => Object.fromEntries(responseHeaders),
  };
}

// ============================================================================
// Utility Tests
// ============================================================================

describe("Utilities", () => {
  describe("getClientIP", () => {
    test("should extract IP from x-forwarded-for header", () => {
      const master = createMockRequest({
        headers: { "x-forwarded-for": "192.168.1.100, 10.0.0.1" },
      });
      expect(getClientIP(master)).toBe("192.168.1.100");
    });

    test("should extract IP from x-real-ip header", () => {
      const master = createMockRequest({
        headers: { "x-real-ip": "192.168.1.200" },
      });
      expect(getClientIP(master)).toBe("192.168.1.200");
    });

    test("should prefer x-forwarded-for over x-real-ip", () => {
      const master = createMockRequest({
        headers: {
          "x-forwarded-for": "192.168.1.100",
          "x-real-ip": "192.168.1.200",
        },
      });
      expect(getClientIP(master)).toBe("192.168.1.100");
    });

    test("should fallback to server requestIP", () => {
      const master = createMockRequest({ ip: "10.0.0.50" });
      expect(getClientIP(master)).toBe("10.0.0.50");
    });

    test("should return 'unknown' if no IP available", () => {
      const master = createMockRequest();
      master.serverInstance.requestIP = () => null;
      expect(getClientIP(master)).toBe("unknown");
    });
  });

  describe("matchRoute", () => {
    test("should match exact paths", () => {
      expect(matchRoute("/api/users", "/api/users")).toBe(true);
      expect(matchRoute("/api/users", "/api/posts")).toBe(false);
    });

    test("should match paths with named parameters", () => {
      expect(matchRoute("/api/users/123", "/api/users/:id")).toBe(true);
      expect(matchRoute("/api/users/abc", "/api/users/:id")).toBe(true);
      expect(matchRoute("/api/users", "/api/users/:id")).toBe(false);
    });

    test("should match paths with wildcards", () => {
      expect(matchRoute("/api/users", "/api/*")).toBe(true);
      expect(matchRoute("/api/posts", "/api/*")).toBe(true);
      // URLPattern * matches any single segment or more
      expect(matchRoute("/api/users/123", "/api/*")).toBe(true);
    });

    test("should match paths with multi-segment wildcards", () => {
      expect(matchRoute("/files/a", "/files/:path*")).toBe(true);
      expect(matchRoute("/files/a/b/c", "/files/:path*")).toBe(true);
    });

    test("should match using RegExp", () => {
      expect(matchRoute("/api/v1/admin", /^\/api\/v[0-9]+\/admin/)).toBe(true);
      expect(matchRoute("/api/v2/admin", /^\/api\/v[0-9]+\/admin/)).toBe(true);
      expect(matchRoute("/api/users", /^\/api\/v[0-9]+\/admin/)).toBe(false);
    });
  });
});

// ============================================================================
// MemoryStore Tests
// ============================================================================

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(60000);
  });

  afterEach(() => {
    store.destroy();
  });

  test("should store and retrieve entries", () => {
    const entry: RateLimitEntry = { count: 5, resetAt: Date.now() + 60000 };
    store.set("test-key", entry);
    expect(store.get("test-key")).toEqual(entry);
  });

  test("should return undefined for non-existent keys", () => {
    expect(store.get("non-existent")).toBeUndefined();
  });

  test("should delete entries", () => {
    store.set("test-key", { count: 1, resetAt: Date.now() + 60000 });
    store.delete("test-key");
    expect(store.get("test-key")).toBeUndefined();
  });

  test("should clear all entries", () => {
    store.set("key1", { count: 1, resetAt: Date.now() + 60000 });
    store.set("key2", { count: 2, resetAt: Date.now() + 60000 });
    store.clear();
    expect(store.get("key1")).toBeUndefined();
    expect(store.get("key2")).toBeUndefined();
  });
});

// ============================================================================
// RateLimiter Class Tests
// ============================================================================

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  describe("Basic Rate Limiting", () => {
    test("should allow requests under the limit", () => {
      limiter = new RateLimiter({ limit: 5, windowMs: 60000 });
      const master = createMockRequest();

      for (let i = 0; i < 5; i++) {
        const result = limiter.check(master);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }
    });

    test("should block requests over the limit", () => {
      limiter = new RateLimiter({ limit: 3, windowMs: 60000 });
      const master = createMockRequest();

      // Use up the limit
      for (let i = 0; i < 3; i++) {
        limiter.check(master);
      }

      // Next request should be blocked
      const result = limiter.check(master);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    test("should use default values", () => {
      limiter = new RateLimiter();
      const master = createMockRequest();

      const result = limiter.check(master);
      expect(result.limit).toBe(100);
    });
  });

  describe("Route-Specific Limits", () => {
    test("should apply route-specific limits", () => {
      limiter = new RateLimiter({
        limit: 100,
        routeLimits: [{ pattern: "/api/auth/*", limit: 5, windowMs: 60000 }],
      });

      const authMaster = createMockRequest({ pathname: "/api/auth/login" });
      const apiMaster = createMockRequest({ pathname: "/api/users" });

      const authResult = limiter.check(authMaster);
      const apiResult = limiter.check(apiMaster);

      expect(authResult.limit).toBe(5);
      expect(apiResult.limit).toBe(100);
    });

    test("should use separate counters for different routes", () => {
      limiter = new RateLimiter({
        limit: 100,
        routeLimits: [{ pattern: "/protected/*", limit: 2, windowMs: 60000 }],
      });

      const master1 = createMockRequest({ pathname: "/" });
      const master2 = createMockRequest({ pathname: "/protected/data" });

      // Hit the default route 50 times
      for (let i = 0; i < 50; i++) {
        limiter.check(master1);
      }

      // Protected route should still have its own limit
      const result = limiter.check(master2);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    test("should apply route-specific window", () => {
      limiter = new RateLimiter({
        limit: 100,
        windowMs: 60000,
        routeLimits: [{ pattern: "/fast/*", limit: 10, windowMs: 1000 }],
      });

      const fastMaster = createMockRequest({ pathname: "/fast/endpoint" });
      const result = limiter.check(fastMaster);

      // Window should be ~1 second from now
      expect(result.resetAt).toBeLessThan(Date.now() + 2000);
    });
  });

  describe("Skip Functionality", () => {
    test("should skip routes by pattern array", () => {
      limiter = new RateLimiter({
        limit: 5,
        skip: ["/health", "/ready"],
      });

      const healthMaster = createMockRequest({ pathname: "/health" });
      const apiMaster = createMockRequest({ pathname: "/api" });

      expect(limiter.shouldSkip(healthMaster)).toBe(true);
      expect(limiter.shouldSkip(apiMaster)).toBe(false);
    });

    test("should skip routes by function", () => {
      limiter = new RateLimiter({
        limit: 5,
        skip: (master) => {
          return master.request.headers.get("x-api-key") === "trusted";
        },
      });

      const trustedMaster = createMockRequest({
        headers: { "x-api-key": "trusted" },
      });
      const normalMaster = createMockRequest();

      expect(limiter.shouldSkip(trustedMaster)).toBe(true);
      expect(limiter.shouldSkip(normalMaster)).toBe(false);
    });
  });

  describe("Custom Key Generator", () => {
    test("should use custom key generator", () => {
      limiter = new RateLimiter({
        limit: 5,
        keyGenerator: (master) => {
          const userId = master.request.headers.get("x-user-id");
          return userId ? `user:${userId}` : `ip:${getClientIP(master)}`;
        },
      });

      const user1 = createMockRequest({ headers: { "x-user-id": "123" } });
      const user2 = createMockRequest({ headers: { "x-user-id": "456" } });

      // Exhaust user 1's limit
      for (let i = 0; i < 5; i++) {
        limiter.check(user1);
      }

      // User 2 should still have requests
      const result = limiter.check(user2);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });
  });

  describe("Headers", () => {
    test("should apply rate limit headers", () => {
      limiter = new RateLimiter({ limit: 10 });
      const master = createMockRequest();

      const result = limiter.check(master);
      limiter.applyHeaders(master, result);

      expect(master.getResponseHeader("X-RateLimit-Limit")).toBe("10");
      expect(master.getResponseHeader("X-RateLimit-Remaining")).toBe("9");
      expect(master.getResponseHeader("X-RateLimit-Reset")).toBeDefined();
    });

    test("should add Retry-After header when rate limited", () => {
      limiter = new RateLimiter({ limit: 1 });
      const master = createMockRequest();

      limiter.check(master); // Use up limit
      const result = limiter.check(master); // Exceed limit
      limiter.applyHeaders(master, result);

      expect(master.getResponseHeader("Retry-After")).toBeDefined();
    });

    test("should not add headers when disabled", () => {
      limiter = new RateLimiter({ limit: 10, headers: false });
      const master = createMockRequest();

      const result = limiter.check(master);
      limiter.applyHeaders(master, result);

      expect(master.getResponseHeader("X-RateLimit-Limit")).toBeUndefined();
    });

    test("should use custom header names", () => {
      limiter = new RateLimiter({
        limit: 10,
        headerNames: {
          limit: "X-Custom-Limit",
          remaining: "X-Custom-Remaining",
        },
      });
      const master = createMockRequest();

      const result = limiter.check(master);
      limiter.applyHeaders(master, result);

      expect(master.getResponseHeader("X-Custom-Limit")).toBe("10");
      expect(master.getResponseHeader("X-Custom-Remaining")).toBe("9");
    });
  });

  describe("Rate Limited Response", () => {
    test("should set response with default message", () => {
      limiter = new RateLimiter({ limit: 1 });
      const master = createMockRequest();

      limiter.check(master);
      const result = limiter.check(master);
      limiter.handleRateLimited(master, result);

      expect(master.isResponseSetted()).toBe(true);
      expect(master.getResponse()?.body).toBe("Too Many Requests");
      expect(master.getResponse()?.init.status).toBe(429);
      expect(master.isSendNowCalled()).toBe(true);
    });

    test("should set response with custom string message", () => {
      limiter = new RateLimiter({
        limit: 1,
        message: "Slow down!",
        statusCode: 503,
      });
      const master = createMockRequest();

      limiter.check(master);
      const result = limiter.check(master);
      limiter.handleRateLimited(master, result);

      expect(master.getResponse()?.body).toBe("Slow down!");
      expect(master.getResponse()?.init.status).toBe(503);
    });

    test("should set response with JSON message", () => {
      limiter = new RateLimiter({
        limit: 1,
        message: { error: "rate_limited", code: "RATE_LIMIT" },
      });
      const master = createMockRequest();

      limiter.check(master);
      const result = limiter.check(master);
      limiter.handleRateLimited(master, result);

      const body = JSON.parse(master.getResponse()?.body || "{}");
      expect(body.error).toBe("rate_limited");
      expect(body.code).toBe("RATE_LIMIT");
    });

    test("should call custom onRateLimited handler", () => {
      const onRateLimited = mock((master: any, result: RateLimitResult) => {
        master.setResponse("Custom handler", { status: 429 });
      });

      limiter = new RateLimiter({ limit: 1, onRateLimited });
      const master = createMockRequest();

      limiter.check(master);
      const result = limiter.check(master);
      limiter.handleRateLimited(master, result);

      expect(onRateLimited).toHaveBeenCalledTimes(1);
      expect(master.getResponse()?.body).toBe("Custom handler");
    });
  });

  describe("Reset Functionality", () => {
    test("should reset by exact key", () => {
      limiter = new RateLimiter({ limit: 3 });
      const master = createMockRequest({ ip: "10.0.0.1" });

      // Use up limit
      for (let i = 0; i < 3; i++) {
        limiter.check(master);
      }

      // Reset
      limiter.reset("10.0.0.1");

      // Should have full limit again
      const result = limiter.check(master);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    test("should reset for current request", () => {
      limiter = new RateLimiter({ limit: 3 });
      const master = createMockRequest({ ip: "10.0.0.2" });

      // Use up limit
      for (let i = 0; i < 3; i++) {
        limiter.check(master);
      }

      // Reset for request
      limiter.resetForRequest(master);

      // Should have full limit again
      const result = limiter.check(master);
      expect(result.allowed).toBe(true);
    });

    test("should reset all routes for a base key", () => {
      limiter = new RateLimiter({
        limit: 100,
        routeLimits: [
          { pattern: "/route1/*", limit: 2 },
          { pattern: "/route2/*", limit: 2 },
        ],
      });

      const master1 = createMockRequest({
        pathname: "/route1/a",
        ip: "1.2.3.4",
      });
      const master2 = createMockRequest({
        pathname: "/route2/b",
        ip: "1.2.3.4",
      });

      // Use up both limits
      limiter.check(master1);
      limiter.check(master1);
      limiter.check(master2);
      limiter.check(master2);

      expect(limiter.check(master1).allowed).toBe(false);
      expect(limiter.check(master2).allowed).toBe(false);

      // Reset all for this IP
      limiter.resetAllForBaseKey("1.2.3.4");

      // Both routes should have limits again
      expect(limiter.check(master1).allowed).toBe(true);
      expect(limiter.check(master2).allowed).toBe(true);
    });

    test("should get full key for request", () => {
      limiter = new RateLimiter({
        limit: 100,
        routeLimits: [{ pattern: "/protected/*", limit: 5 }],
      });

      const master = createMockRequest({
        pathname: "/protected/data",
        ip: "5.6.7.8",
      });
      const key = limiter.getFullKeyForRequest(master);

      expect(key).toContain("5.6.7.8");
      expect(key).toContain(":route:");
      expect(key).toContain("/protected/*");
    });

    test("should get base key for request", () => {
      limiter = new RateLimiter({
        limit: 100,
        routeLimits: [{ pattern: "/protected/*", limit: 5 }],
      });

      const master = createMockRequest({
        pathname: "/protected/data",
        ip: "5.6.7.8",
      });
      const key = limiter.getBaseKeyForRequest(master);

      expect(key).toBe("5.6.7.8");
    });
  });

  describe("Window Expiry", () => {
    test("should reset count after window expires", async () => {
      limiter = new RateLimiter({ limit: 2, windowMs: 100 });
      const master = createMockRequest();

      // Use up limit
      limiter.check(master);
      limiter.check(master);
      expect(limiter.check(master).allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have full limit again
      const result = limiter.check(master);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });
  });

  describe("Custom Store", () => {
    test("should use custom store", () => {
      const customStore: RateLimitStore & {
        store: Map<string, RateLimitEntry>;
      } = {
        store: new Map<string, RateLimitEntry>(),
        get(key: string) {
          return this.store.get(key);
        },
        set(key: string, entry: RateLimitEntry) {
          this.store.set(key, entry);
        },
        delete(key: string) {
          this.store.delete(key);
        },
        clear() {
          this.store.clear();
        },
      };

      limiter = new RateLimiter({ limit: 5, store: customStore });
      const master = createMockRequest();

      limiter.check(master);

      // Verify store was used
      expect(customStore.store.size).toBe(1);
    });
  });
});

// ============================================================================
// Plugin Integration Tests
// ============================================================================

describe("Rate Limiter Plugin", () => {
  test("should create plugin with correct structure", () => {
    const plugin = rateLimiter({ limit: 100 });

    expect(plugin.name).toBe("frame-master-plugin-rate-limiter");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.router?.before_request).toBeDefined();
    expect(plugin.router?.request).toBeDefined();
    expect(plugin.serverStart?.main).toBeDefined();
  });

  test("should use custom priority", () => {
    const plugin = rateLimiter({ priority: 50 });
    expect(plugin.priority).toBe(50);
  });

  test("should have correct requirements", () => {
    const plugin = rateLimiter();

    expect(plugin.requirement?.frameMasterVersion).toBe("^3.0.0");
    expect(plugin.requirement?.bunVersion).toBe(">=1.2.0");
  });
});

// ============================================================================
// Exported Utility Functions Tests
// ============================================================================

describe("Exported Utility Functions", () => {
  describe("Context Functions", () => {
    test("resetRateLimit should return false if not in rate limit context", () => {
      const master = createMockRequest();
      expect(resetRateLimit(master)).toBe(false);
    });

    test("resetRateLimit should call reset function from context", () => {
      const master = createMockRequest();
      const resetFn = mock(() => {});
      master.setContext({ __rateLimitReset: resetFn });

      expect(resetRateLimit(master)).toBe(true);
      expect(resetFn).toHaveBeenCalled();
    });

    test("resetAllRateLimits should call resetAll function from context", () => {
      const master = createMockRequest();
      const resetAllFn = mock(() => {});
      master.setContext({ __rateLimitResetAll: resetAllFn });

      expect(resetAllRateLimits(master)).toBe(true);
      expect(resetAllFn).toHaveBeenCalled();
    });

    test("resetRateLimitByKey should call resetByKey function from context", () => {
      const master = createMockRequest();
      const resetByKeyFn = mock((key: string) => {});
      master.setContext({ __rateLimitResetByKey: resetByKeyFn });

      expect(resetRateLimitByKey(master, "test-key")).toBe(true);
      expect(resetByKeyFn).toHaveBeenCalledWith("test-key");
    });

    test("getRateLimitKey should return key from context", () => {
      const master = createMockRequest();
      master.setContext({ __rateLimitKey: "ip:127.0.0.1:route:/api/*" });

      expect(getRateLimitKey(master)).toBe("ip:127.0.0.1:route:/api/*");
    });

    test("getRateLimitBaseKey should return base key from context", () => {
      const master = createMockRequest();
      master.setContext({ __rateLimitBaseKey: "ip:127.0.0.1" });

      expect(getRateLimitBaseKey(master)).toBe("ip:127.0.0.1");
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge Cases", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  test("should handle limit of 0", () => {
    limiter = new RateLimiter({ limit: 0 });
    const master = createMockRequest();

    const result = limiter.check(master);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("should handle very high limits", () => {
    limiter = new RateLimiter({ limit: 1000000 });
    const master = createMockRequest();

    const result = limiter.check(master);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(1000000);
  });

  test("should handle concurrent requests from same IP", () => {
    limiter = new RateLimiter({ limit: 10 });

    const requests = Array.from({ length: 10 }, () => createMockRequest());
    const results = requests.map((master) => limiter.check(master));

    // All should be allowed
    expect(results.every((r) => r.allowed)).toBe(true);

    // 11th request should be blocked
    const blocked = limiter.check(createMockRequest());
    expect(blocked.allowed).toBe(false);
  });

  test("should handle requests from different IPs independently", () => {
    limiter = new RateLimiter({ limit: 2 });

    const ip1 = createMockRequest({ ip: "1.1.1.1" });
    const ip2 = createMockRequest({ ip: "2.2.2.2" });

    // Exhaust IP1
    limiter.check(ip1);
    limiter.check(ip1);
    expect(limiter.check(ip1).allowed).toBe(false);

    // IP2 should still work
    expect(limiter.check(ip2).allowed).toBe(true);
  });

  test("should handle empty skip array", () => {
    limiter = new RateLimiter({ limit: 5, skip: [] });
    const master = createMockRequest();

    expect(limiter.shouldSkip(master)).toBe(false);
  });

  test("should handle empty routeLimits array", () => {
    limiter = new RateLimiter({ limit: 5, routeLimits: [] });
    const master = createMockRequest({ pathname: "/api/users" });

    const result = limiter.check(master);
    expect(result.limit).toBe(5);
  });

  test("should handle special characters in pathname", () => {
    limiter = new RateLimiter({ limit: 5 });
    const master = createMockRequest({
      pathname: "/api/users?query=test&foo=bar",
    });

    const result = limiter.check(master);
    expect(result.allowed).toBe(true);
  });

  test("should handle IPv6 addresses", () => {
    limiter = new RateLimiter({ limit: 5 });
    const master = createMockRequest({ ip: "::1" });

    const result = limiter.check(master);
    expect(result.allowed).toBe(true);
  });

  test("should handle multiple route patterns matching same path", () => {
    limiter = new RateLimiter({
      limit: 100,
      routeLimits: [
        { pattern: "/api/*", limit: 50 },
        { pattern: "/api/users", limit: 10 }, // More specific
      ],
    });

    const master = createMockRequest({ pathname: "/api/users" });
    const result = limiter.check(master);

    // First matching pattern wins
    expect(result.limit).toBe(50);
  });
});
