/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;
