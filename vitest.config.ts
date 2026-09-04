import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Next.js는 JSX를 보존하지만 Vitest는 컴포넌트 단위 검증을 위해 변환이 필요하다.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
