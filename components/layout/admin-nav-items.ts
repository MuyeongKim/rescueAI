import {
  BarChart3,
  FolderCog,
  Megaphone,
  Newspaper,
  Users,
  type LucideIcon,
} from "lucide-react";

// 관리자 메뉴 단일 출처 — 데스크톱 사이드바(AppSidebar)·모바일 더보기(MobileMoreSheet)·
// 관리자 상단 탭(AdminNav)이 모두 이 목록에서 파생한다. 새 관리자 페이지는 여기만 추가하면 된다.
export type AdminNavItem = { key: string; href: string; label: string; icon: LucideIcon };

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { key: "admin", href: "/admin", label: "통계", icon: BarChart3 },
  { key: "admin-news", href: "/admin/news", label: "동향 관리", icon: Newspaper },
  { key: "admin-documents", href: "/admin/documents", label: "자료 관리", icon: FolderCog },
  { key: "admin-users", href: "/admin/users", label: "사용자 관리", icon: Users },
  { key: "admin-notices", href: "/admin/notices", label: "공지 작성", icon: Megaphone },
];
