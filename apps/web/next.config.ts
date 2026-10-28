import type { NextConfig } from "next";
// The Node/Docker deployment runs `next start` with installed dependencies.
const config: NextConfig = { poweredByHeader: false };
export default config;
