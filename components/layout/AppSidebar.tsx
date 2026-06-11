import Link from "next/link";
import {
  Flame,
  LogOut,
  MessageSquare,
  FileText,
  BarChart3,
  Home,
  GraduationCap,
  Dumbbell,
  Megaphone,
  CircleUser,
  FolderCog,
  Users,
  Award,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { cn } from "@/lib/utils";
import { hasRecentNotice } from "@/lib/notices";

export type NavKey =
  | "home"
  | "courses"
  | "chat"
  | "generate"
  | "docs"
  | "fitness"
  | "me"
  | "admin"
  | "admin-completion"
  | "admin-documents"
  | "admin-users"
  | "admin-notices";

type NavItem = {
  key: NavKey;
  href: string;
  label: string;
  icon: typeof Flame;
  /** 모바일 하단 탭바 노출 여부 (6개 제한) */
  mobile?: boolean;
};

// 공지사항은 메뉴에서 제외 — 홈의 공지 섹션('전체 보기' → /notices)으로만 진입한다.
// 모바일 탭바는 6개 제한 — 자료실은 학습 과정·홈에서 진입 가능해 모바일에서 제외.
const NAV_ITEMS: NavItem[] = [
  { key: "home", href: "/home", label: "홈", icon: Home, mobile: true },
  { key: "courses", href: "/courses", label: "학습", icon: GraduationCap, mobile: true },
  { key: "chat", href: "/chat", label: "AI 튜터", icon: MessageSquare, mobile: true },
  { key: "generate", href: "/generate", label: "자료 생성", icon: Wand2, mobile: true },
  { key: "docs", href: "/docs", label: "자료실", icon: FileText },
  { key: "fitness", href: "/fitness", label: "체력단련", icon: Dumbbell, mobile: true },
  { key: "me", href: "/me", label: "마이페이지", icon: CircleUser, mobile: true },
];

const ADMIN_ITEMS: NavItem[] = [
  { key: "admin", href: "/admin", label: "통계", icon: BarChart3 },
  { key: "admin-completion", href: "/admin/completion", label: "이수 현황", icon: Award },
  { key: "admin-documents", href: "/admin/documents", label: "자료 관리", icon: FolderCog },
  { key: "admin-users", href: "/admin/users", label: "사용자 관리", icon: Users },
  { key: "admin-notices", href: "/admin/notices", label: "공지 작성", icon: Megaphone },
];

export async function AppSidebar({
  email,
  isAdmin,
  active,
  hideMobileNav,
}: {
  email?: string | null;
  isAdmin?: boolean;
  active?: NavKey;
  /** 채팅 등 몰입형 화면에서 모바일 하단 탭바를 숨긴다(입력창 충돌 방지). */
  hideMobileNav?: boolean;
}) {
  const mobileItems = NAV_ITEMS.filter((i) => i.mobile);
  const newNotice = await hasRecentNotice();

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = active === item.key;
    return (
      <Link key={item.key} href={item.href} aria-current={isActive ? "page" : undefined}>
        <Button
          variant={isActive ? "secondary" : "ghost"}
          className={cn(
            "w-full justify-start gap-2 h-10 px-3 text-sm",
            isActive && "font-medium"
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {item.label}
          {item.key === "home" && newNotice && (
            <span
              className="ml-auto h-2 w-2 rounded-full bg-primary"
              aria-label="새 공지 있음"
            />
          )}
        </Button>
      </Link>
    );
  };

  return (
    <>
      {/* 데스크톱 좌측 사이드바 (md 이상) */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r bg-background sticky top-0 h-screen">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Link href="/home" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
              <Flame className="h-4 w-4 text-primary" />
            </span>
            <span className="text-sm">전북소방 구조 AI</span>
          </Link>
        </div>

        <nav aria-label="주 메뉴" className="flex flex-col gap-0.5 p-2 flex-1 overflow-y-auto">
          {NAV_ITEMS.map(renderItem)}

          {isAdmin && (
            <>
              <p className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">
                관리자
              </p>
              {ADMIN_ITEMS.map(renderItem)}
            </>
          )}
        </nav>

        <div className="border-t p-2 space-y-1">
          {email && (
            <p className="truncate px-3 py-1.5 text-xs text-muted-foreground">
              {email}
            </p>
          )}
          <ThemeToggle />
          <form action="/auth/signout" method="post">
            <Button
              type="submit"
              variant="ghost"
              className="w-full justify-start gap-2 h-10 px-3 text-sm text-muted-foreground"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              로그아웃
            </Button>
          </form>
        </div>
      </aside>

      {/* 모바일 하단 탭바 (md 미만, 6개) — 몰입형 화면에서는 숨김 */}
      <nav
        aria-label="주 메뉴"
        className={cn(
          "md:hidden fixed bottom-0 left-0 right-0 z-30 border-t bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/60",
          hideMobileNav && "hidden"
        )}
      >
        <div className="flex items-center justify-around h-14 px-1">
          {mobileItems.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.key;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors min-w-[48px]",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
                <span className={cn("text-xs", isActive && "font-medium")}>
                  {item.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
