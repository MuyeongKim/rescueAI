import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AdminNav } from "@/components/admin/AdminNav";
import { getUserAndProfile, isAdmin } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getUserAndProfile();

  // 접근 제어 (AC-9): 관리자만. 아니면 /chat 으로.
  if (!isAdmin(profile)) {
    redirect("/chat");
  }

  return (
    <div className="flex h-screen">
      <AppSidebar email={user?.email} isAdmin active="admin" />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 overflow-auto pb-[calc(5rem+env(safe-area-inset-bottom))] focus:outline-none md:pb-0"
      >
        <AdminNav />
        {children}
      </main>
    </div>
  );
}
