import { AppSidebar } from "@/components/layout/AppSidebar";
import { getUserAndProfile, isAdmin } from "@/lib/auth";

export default async function NoticesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getUserAndProfile();
  return (
    <div className="flex h-screen">
      {/* 공지는 홈에서 진입하는 보조 화면 — 활성 메뉴 없음 */}
      <AppSidebar email={user?.email} isAdmin={isAdmin(profile)} />
      <main className="flex-1 overflow-auto pb-14 md:pb-0">{children}</main>
    </div>
  );
}
