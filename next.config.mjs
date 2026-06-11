/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Supabase Storage 공개 URL (원본 PDF/썸네일 등)
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
    ],
  },
  webpack: (config, { isServer, webpack }) => {
    // react-pdf(pdfjs-dist)가 선택적으로 요구하는 node 'canvas' 모듈을 비활성화
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };
    if (!isServer) {
      // pptxgenjs가 Node 환경용으로 참조하는 node: 내장 모듈을 브라우저 번들에서 제거
      // (브라우저 실행 경로에서는 쓰이지 않는 코드)
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        })
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        https: false,
        http: false,
      };
    }
    return config;
  },
};

export default nextConfig;
