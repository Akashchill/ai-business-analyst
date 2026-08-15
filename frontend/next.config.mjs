/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Gzip would wrap the /api SSE proxy and truncate chunked streams behind ALB.
  compress: false,
};

export default nextConfig;
