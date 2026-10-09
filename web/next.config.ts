import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder (a stray lockfile higher up confuses Next's detection).
  outputFileTracingRoot: path.join(__dirname),
  // Optional: build into another folder (e.g. a test build while `npm start` is serving .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
