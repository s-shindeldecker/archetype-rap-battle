import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep the LD SDKs as plain Node requires rather than bundling them.
  serverExternalPackages: ['@launchdarkly/node-server-sdk', '@launchdarkly/server-sdk-ai'],
};

export default nextConfig;
