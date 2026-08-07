import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: config => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
  experimental: {
    turbo: {
      resolveAlias: {
        // Node builtins are stubbed for the browser only. Aliasing them
        // unconditionally also hits the server/SSR graphs, where real `fs` is
        // needed (app/api/circuit/route.ts, @aztec/bb.js' node entry) and the
        // stub's missing named exports become hard build errors.
        fs: { browser: "./empty-module.ts" },
        net: { browser: "./empty-module.ts" },
        tls: { browser: "./empty-module.ts" },
        "pino-pretty": "./empty-module.ts",
        lokijs: "./empty-module.ts",
        encoding: "./empty-module.ts",
      },
    },
  },
};

const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";

if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}

module.exports = nextConfig;
