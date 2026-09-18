import path from 'node:path';
import type { NextConfig } from 'next';

const repoRoot = path.resolve(__dirname, '../..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Monorepo: trace and resolve workspace packages from the repository root.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
