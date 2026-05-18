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
  //
  // Boot-time work (chat, eventsub, games, scene seeds) is NOT
  // hooked via instrumentation.ts — that file was fragile with
  // Next 14 standalone output and the Edge-runtime default for
  // instrumentation bundles. Instead `lib/boot.ts` exports a
  // `bootOnce()` that the admin server-component and every
  // `ownerRoute`-wrapped API call invoke; the module-level guard
  // makes it idempotent.
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
