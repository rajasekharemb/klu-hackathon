/** @type {import('next').NextConfig} */
const nextConfig = {
  // Posters are hot-linked from the sites that publish them, so <img> is used directly
  // rather than next/image (which would need every CDN host allow-listed up front).
  reactStrictMode: true,
};

export default nextConfig;
