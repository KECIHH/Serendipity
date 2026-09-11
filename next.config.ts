import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the configured authentication origin intact through the middleware adapter,
  // including numeric loopback hosts that NextURL otherwise changes to localhost.
  skipMiddlewareUrlNormalize: true,
};

export default nextConfig;
