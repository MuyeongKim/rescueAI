/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Supabase Storage 공개 URL (원본 PDF/썸네일 등)
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
    ],
  },
  webpack: (config) => {
    // react-pdf(pdfjs-dist)가 선택적으로 요구하는 node 'canvas' 모듈을 비활성화
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
