import type { NextConfig } from "next";

const allowedOrigins =
  process.env.ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

const nextConfig: NextConfig = {
  // Keep the new acceptance server's build artifacts separate from the mobile test server.
  distDir:
    process.env.BUPPANCHO_TEST_INSTANCE === "validation"
      ? ".next-validation"
      : process.env.BUPPANCHO_TEST_INSTANCE === "money-history"
        ? ".next-money-history"
        : process.env.BUPPANCHO_TEST_INSTANCE === "redesign-build"
          ? ".next-redesign-build"
          : process.env.BUPPANCHO_TEST_INSTANCE === "redesign"
            ? ".next-redesign"
            : process.env.BUPPANCHO_TEST_INSTANCE === "phase2"
              ? ".next-phase2"
              : ".next",
  output: "standalone",
  poweredByHeader: false,
  // 開発ツールの表示がスマホ下部ナビと重なるため、画面上のインジケーターは表示しない。
  devIndicators: false,
  allowedDevOrigins: allowedOrigins.map((value) => value.split(":", 1)[0]!),
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
