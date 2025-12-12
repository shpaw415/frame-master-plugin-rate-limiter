import type { FrameMasterConfig } from "frame-master/server/types";
import rateLimiterPlugin from "..";

export default {
  HTTPServer: {
    port: 3000,
  },
  plugins: [
    rateLimiterPlugin({
      limit: 4,
      message: "Too many requests, please try again later.",
      windowMs: 10 * 1000, // 10 seconds
      skip: ["/favicon.ico"],
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
