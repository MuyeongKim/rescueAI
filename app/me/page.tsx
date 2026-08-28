import Link from "next/link";
import {
  BarChart3,
  ChevronRight,
  CircleUser,
  FolderOpen,
  LogOut,
} from "lucide-react";

import { requireUserAndProfile } from "@/lib/auth";
import { countMyMaterials } from "@/lib/generated-materials";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const { user, profile } = await requireUserAndProfile();
  const savedCount = await countMyMaterials();

  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="대원 정보 · 개인 현황"
        title="마이페이지"
        description="내 정보와 저장한 자료를 확인합니다."
        icon={CircleUser}
        status={profile?.role === "admin" ? "관리자 계정" : "대원 계정"}
      />

      {/* 프로필 */}
      <Card>
        <CardContent className="flex items-center gap-4 p-5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <CircleUser className="h-7 w-7 text-primary" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{name}</span>
              {profile?.role === "admin" && <Badge variant="secondary">관리자</Badge>}
            </div>
            <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
            {profile?.division && (
              <p className="text-sm text-muted-foreground">{profile.division}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* AI 자료제작 — 저장한 자료 바로가기 */}
      <Card>
        <CardContent className="p-2">
          <Link
            href="/generate/saved"
            className="flex h-12 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent/60"
          >
            <FolderOpen className="h-4 w-4 text-primary" />
            저장한 자료
            {savedCount > 0 && (
              <Badge variant="secondary" className="font-normal">
                {savedCount}
              </Badge>
            )}
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </Link>
        </CardContent>
      </Card>

      {/* 화면 설정 — 모바일에는 사이드바가 없으므로 테마 전환을 여기에도 노출 */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <ThemeToggle />
        </CardContent>
      </Card>

      {/* 로그아웃 — 모바일 탭바·사이드바가 없어 여기가 유일한 로그아웃 동선(데스크톱은 사이드바) */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex h-12 w-full items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              로그아웃
            </button>
          </form>
        </CardContent>
      </Card>

      {/* 관리자 진입 — 모바일 탭바에 관리자 메뉴가 없어 여기가 유일한 동선 */}
      {profile?.role === "admin" && (
        <Card>
          <CardContent className="p-2">
            <Link
              href="/admin"
              className="flex h-12 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent/60"
            >
              <BarChart3 className="h-4 w-4 text-primary" />
              관리자 · 통계·자료·사용자·공지
              <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
