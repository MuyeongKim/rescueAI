import { AppSidebar } from "@/components/layout/AppSidebar";
import { AdminNav } from "@/components/admin/AdminNav";
import { requireAdminAndProfile } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await requireAdminAndProfile();

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
