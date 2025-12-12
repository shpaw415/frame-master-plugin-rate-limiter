# frame-master-plugin-rate-limiter

A modular, flexible rate limiting plugin for [Frame-Master](https://frame-master.com).

## Features

- 🚦 **Configurable limits** - Set requests per time window
- 🛤️ **Route-specific limits** - Different limits for different endpoints
- 🔑 **Custom key generation** - Rate limit by IP, user ID, API key, etc.
- 💾 **Pluggable stores** - In-memory (default), Redis, database, etc.
- 📊 **Standard headers** - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- ⏭️ **Skip routes** - Exclude health checks, static files, webhooks
- 🎨 **Custom responses** - Configurable message, status code, or handler

## Installation

```bash
bun add frame-master-plugin-rate-limiter
```

## Quick Start

```typescript
import type { FrameMasterConfig } from "frame-master/server/types";
import rateLimiter from "frame-master-plugin-rate-limiter";

const config: FrameMasterConfig = {
  HTTPServer: { port: 3000 },
  plugins: [
    rateLimiter({
      limit: 100, // 100 requests
      windowMs: 60_000, // per minute
    }),
  ],
};

export default config;
```

## Configuration Options

| Option          | Type                   | Default               | Description                                 |
| --------------- | ---------------------- | --------------------- | ------------------------------------------- |
| `limit`         | `number`               | `100`                 | Maximum requests per window                 |
| `windowMs`      | `number`               | `60000`               | Time window in milliseconds                 |
| `keyGenerator`  | `function`             | Client IP             | Function to extract unique key from request |
| `store`         | `RateLimitStore`       | `MemoryStore`         | Custom store for rate limit data            |
| `skip`          | `string[] \| function` | `undefined`           | Routes or function to skip rate limiting    |
| `routeLimits`   | `RouteLimit[]`         | `undefined`           | Route-specific limit overrides              |
| `onRateLimited` | `function`             | `undefined`           | Custom handler when rate limited            |
| `headers`       | `boolean`              | `true`                | Add rate limit headers to responses         |
| `headerNames`   | `object`               | See below             | Customize header names                      |
| `message`       | `string \| object`     | `"Too Many Requests"` | Response body when rate limited             |
| `statusCode`    | `number`               | `429`                 | HTTP status code when rate limited          |

### Default Header Names

```typescript
{
  limit: "X-RateLimit-Limit",
  remaining: "X-RateLimit-Remaining",
  reset: "X-RateLimit-Reset",
  retryAfter: "Retry-After",
}
```

## Examples

### Route-Specific Limits

Apply stricter limits to sensitive endpoints using [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern) syntax:

```typescript
rateLimiter({
  limit: 100, // Default: 100 req/min
  windowMs: 60_000,
  routeLimits: [
    // Auth endpoints: 5 requests per minute (matches /api/auth, /api/auth/login, etc.)
    { pattern: "/api/auth/*", limit: 5, windowMs: 60_000 },
    // Login specifically: 3 requests per minute
    { pattern: "/api/auth/login", limit: 3, windowMs: 60_000 },
    // File uploads: 10 per 5 minutes
    { pattern: "/api/upload", limit: 10, windowMs: 300_000 },
    // Named parameters: match user endpoints
    { pattern: "/api/users/:id", limit: 50 },
    // Regex support (alternative to URLPattern)
    { pattern: /^\/api\/v[0-9]+\/admin/, limit: 20 },
  ],
});
```

#### URLPattern Syntax Quick Reference

| Pattern          | Matches                            | Does Not Match            |
| ---------------- | ---------------------------------- | ------------------------- |
| `/api/users`     | `/api/users`                       | `/api/users/123`          |
| `/api/users/:id` | `/api/users/123`, `/api/users/abc` | `/api/users`              |
| `/api/*`         | `/api/users`, `/api/posts`         | `/api/users/123`          |
| `/static/*`      | `/static/style.css`                | `/static/images/logo.png` |
| `/files/:path*`  | `/files/a`, `/files/a/b/c`         | `/files`                  |

### Skip Certain Routes

Exclude routes from rate limiting:

```typescript
rateLimiter({
  limit: 100,
  // Skip by URLPattern patterns
  skip: ["/health", "/ready", "/static/*", "/webhooks/:provider"],
});

// Or with a function
rateLimiter({
  limit: 100,
  skip: (master) => {
    // Skip if request has valid API key
    const apiKey = master.request.headers.get("x-api-key");
    return apiKey === process.env.TRUSTED_API_KEY;
  },
});
```

### Custom Key Generator

Rate limit by user ID instead of IP:

```typescript
rateLimiter({
  limit: 100,
  keyGenerator: (master) => {
    // Get user ID from context (set by auth plugin)
    const ctx = master.getContext<{ userId?: string }>();
    if (ctx.userId) {
      return `user:${ctx.userId}`;
    }
    // Fallback to IP for unauthenticated requests
    return `ip:${getClientIP(master)}`;
  },
});
```

Rate limit by API key:

```typescript
import { getClientIP } from "frame-master-plugin-rate-limiter";

rateLimiter({
  keyGenerator: (master) => {
    const apiKey = master.request.headers.get("x-api-key");
    return apiKey ? `api:${apiKey}` : `ip:${getClientIP(master)}`;
  },
});
```

### Custom Rate Limited Response

Return JSON error response (automatically set by the plugin):

```typescript
rateLimiter({
  limit: 100,
  message: {
    error: "rate_limit_exceeded",
    message: "Too many requests, please try again later",
  },
  statusCode: 429,
  // The plugin automatically calls master.setResponse() and master.sendNow()
  // with the message as JSON body when rate limit is exceeded
});
```

Or handle it yourself:

```typescript
rateLimiter({
  limit: 100,
  onRateLimited: (master, result) => {
    master.setResponse(
      JSON.stringify({
        error: "rate_limit_exceeded",
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
        limit: result.limit,
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );
    master.sendNow();
  },
});
```

### Custom Store (Redis Example)

Implement the `RateLimitStore` interface for distributed rate limiting:

```typescript
import type {
  RateLimitStore,
  RateLimitEntry,
} from "frame-master-plugin-rate-limiter";
import { Redis } from "ioredis";

class RedisStore implements RateLimitStore {
  private redis: Redis;
  private prefix: string;

  constructor(redis: Redis, prefix = "ratelimit:") {
    this.redis = redis;
    this.prefix = prefix;
  }

  async get(key: string): Promise<RateLimitEntry | undefined> {
    const data = await this.redis.get(this.prefix + key);
    return data ? JSON.parse(data) : undefined;
  }

  async set(key: string, entry: RateLimitEntry): Promise<void> {
    const ttl = Math.ceil((entry.resetAt - Date.now()) / 1000);
    await this.redis.setex(this.prefix + key, ttl, JSON.stringify(entry));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(this.prefix + "*");
    if (keys.length) await this.redis.del(...keys);
  }
}

// Usage
const redis = new Redis(process.env.REDIS_URL);

rateLimiter({
  limit: 100,
  store: new RedisStore(redis),
});
```

### Disable Headers

```typescript
rateLimiter({
  limit: 100,
  headers: false, // Don't add X-RateLimit-* headers
});
```

### Custom Header Names

```typescript
rateLimiter({
  limit: 100,
  headerNames: {
    limit: "X-Rate-Limit-Max",
    remaining: "X-Rate-Limit-Remaining",
    reset: "X-Rate-Limit-Reset-At",
    retryAfter: "X-Retry-After",
  },
});
```

## Response Headers

When a request is made, these headers are added to the response:

| Header                  | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `X-RateLimit-Limit`     | Maximum requests allowed in the window              |
| `X-RateLimit-Remaining` | Requests remaining in current window                |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets               |
| `Retry-After`           | Seconds until rate limit resets (only when limited) |

## Accessing Rate Limit Result

The rate limit result is stored in context for other plugins:

```typescript
// In another plugin's request handler
const result = master.getContext<{ __rateLimitResult?: RateLimitResult }>()
  .__rateLimitResult;

if (result) {
  console.log(`${result.remaining}/${result.limit} requests remaining`);
}
```

## API Reference

### Exports

```typescript
// Default export - the plugin factory
import rateLimiter from "frame-master-plugin-rate-limiter";

// Named exports for custom implementations
import {
  RateLimiter, // Core rate limiter class
  MemoryStore, // Default in-memory store
  getClientIP, // Utility to extract client IP
  matchRoute, // Utility for URLPattern/regex route matching
} from "frame-master-plugin-rate-limiter";

// Types
import type {
  RateLimiterOptions,
  RateLimitStore,
  RateLimitEntry,
  RateLimitResult,
  RouteLimit,
} from "frame-master-plugin-rate-limiter";
```

### `RateLimitStore` Interface

```typescript
interface RateLimitStore {
  get(
    key: string
  ): RateLimitEntry | undefined | Promise<RateLimitEntry | undefined>;
  set(key: string, entry: RateLimitEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

interface RateLimitEntry {
  count: number;
  resetAt: number; // Unix timestamp in milliseconds
}
```

### `RateLimitResult` Interface

```typescript
interface RateLimitResult {
  allowed: boolean; // Whether the request is allowed
  remaining: number; // Requests remaining in window
  resetAt: number; // Unix timestamp when window resets
  limit: number; // Maximum requests for this route
}
```

## Requirements

- Frame-Master `^3.0.0`
- Bun `>=1.2.0`

## License

MIT
