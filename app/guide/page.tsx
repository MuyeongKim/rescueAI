import type { Metadata } from "next";

import { UserGuideContent } from "@/components/guide/UserGuideContent";
import { UserGuideOnboarding } from "@/components/guide/UserGuideOnboarding";

export const metadata: Metadata = {
  title: "사용설명서 | 구조 AI",
  description: "AI 튜터 질문부터 훈련계획·교안·PPT 제작, 저장과 원본 확인까지 쉬운 사용 안내입니다.",
};

export default function UserGuidePage() {
  return <UserGuideContent actions={<UserGuideOnboarding automatic={false} />} />;
}
