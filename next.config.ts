import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pino is a server-only dependency; keep it external to the bundle.
  serverExternalPackages: ["pino"],
};

export default nextConfig;
