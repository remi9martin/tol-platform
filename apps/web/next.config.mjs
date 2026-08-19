import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    // Next's own workspace-root auto-detection walks up from this file
    // and found an unrelated pnpm-workspace.yaml further up the directory
    // tree (the parent directory contains other, unrelated projects, not
    // just this monorepo) and warned about the ambiguity. Pinning the
    // root explicitly to this monorepo silences that and removes any
    // doubt about which workspace Turbopack is resolving against.
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
};

export default nextConfig;
