/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` produces a minimal server.js + node_modules
  // tree under .next/standalone, which the Dockerfile copies
  // into a tiny runtime image. Much smaller than shipping the
  // full repo.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,

  // better-sqlite3 ships a prebuilt native .node binary and
  // can't be bundled. ws relies on optional native bufferutil.
  // music-metadata is CommonJS but pulls in some platform-y stuff
  // (large file streams) we don't want webpack to walk through.
  //
  // In Next.js 14.x this option lives under `experimental`; the
  // top-level `serverExternalPackages` was added in 15.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "ws", "music-metadata"],
    // Default body limit for server actions is 1MB, way too low for
    // VOD / FLAC uploads. Multipart route handlers use a separate
    // mechanism but bumping this avoids surprises in any future
    // action-based code paths.
    serverActions: { bodySizeLimit: "4gb" },
  },
};

export default nextConfig;
