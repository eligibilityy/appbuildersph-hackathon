import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder (a stray lockfile higher up confuses Next's detection).
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
