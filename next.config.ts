import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server with only the files it actually imports, so
  // the container does not carry node_modules. Required by the Dockerfile.
  output: "standalone",
};

export default nextConfig;
