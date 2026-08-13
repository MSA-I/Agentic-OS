import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // CI and local QA can isolate build output from a running desktop instance.
  distDir: process.env.AGENT_OS_NEXT_DIST_DIR || ".next",
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
