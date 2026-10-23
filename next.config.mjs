/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app holds billing and audit data and is only meant to be opened
  // behind Cloudflare Access. Never let a browser cache or frame it.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
