import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  transpilePackages: [
    "@lore/core",
    "@lore/adapter-mysql",
    "@lore/adapter-elasticsearch",
  ],
  turbopack: {
    root: process.cwd(),
  },
};

export default withEve(nextConfig);
