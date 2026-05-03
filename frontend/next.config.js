/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow connections from Docker network (nginx proxy)
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_BACKEND_URL || "http://backend:8000"}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
