import { withWorkflow } from "workflow/next";

// 보안 응답 헤더.
// CSP: Next 는 인라인 스크립트/스타일을 쓰므로 'unsafe-inline' 이 필요하다(개발 모드는 eval 도).
//      script-src 를 self 로 묶는 것만으로도 외부 스크립트 주입 경로는 크게 줄어든다.
// connect-src: Supabase(REST/Realtime/Storage) 와 자체 임베딩/한글 미니서버를 허용해야 하므로
//      https/wss 를 열어 둔다. 더 조이려면 배포 도메인을 명시할 것.
const isDev = process.env.NODE_ENV === "development";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:", // react-pdf(pdf.js) 워커
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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

const workflowConfig = withWorkflow(nextConfig);

// Workflow adapter는 Next 16용 `turbopack` 키도 함께 주입한다. 이 프로젝트는 Next 14의
// webpack 빌드를 사용하므로 adapter가 loader/build를 구성한 뒤 미지원 키만 제거한다.
export default async function configuredNext(phase, context) {
  const config = await workflowConfig(phase, context);
  delete config.turbopack;
  return config;
}
