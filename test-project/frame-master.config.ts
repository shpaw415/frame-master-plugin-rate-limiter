import type { FrameMasterConfig } from "frame-master/server/types";
import rateLimiterPlugin from "..";

export default {
  HTTPServer: {
    port: 3000,
  },
  plugins: [
    rateLimiterPlugin({
      message: "Too many requests, please try again later.",
      routeLimits: [
        {
          limit: 5,
          pattern: "/protected**",
          windowMs: 10 * 1000, // 1 minute
        },
      ],
    }),
    {
      name: "test-rate-limiter",
      version: "1.0.0",
      router: {
        request(master) {
          if (master.isResponseSetted()) return;
          master.setResponse("Hello from Rate Limiter Plugin");
        },
      },
    },
  ],
} satisfies FrameMasterConfig;
