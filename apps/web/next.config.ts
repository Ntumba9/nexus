import path from 'node:path';
import type { NextConfig } from 'next';
import { STATIC_SECURITY_HEADERS } from './src/lib/csp';

const repoRoot = path.resolve(__dirname, '../..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Monorepo: trace and resolve workspace packages from the repository root.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
