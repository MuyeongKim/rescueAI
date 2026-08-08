import { AppSidebar } from "@/components/layout/AppSidebar";
import { requireUserAndProfile, isAdmin } from "@/lib/auth";

export default async function NoticesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireUserAndProfile();
  return (
    <div className="flex h-screen">
      {/* 공지는 데스크톱 사이드바엔 없지만, 모바일 더보기 시트·탭에선 활성 표시되게 active 전달 */}
      <AppSidebar email={user?.email} isAdmin={isAdmin(profile)} active="notices" />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 overflow-auto pb-[calc(5rem+env(safe-area-inset-bottom))] focus:outline-none md:pb-0"
      >
        {children}
      </main>
    </div>
  );
}
