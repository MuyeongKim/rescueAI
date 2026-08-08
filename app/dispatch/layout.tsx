import { AppSidebar } from "@/components/layout/AppSidebar";
import { requireUserAndProfile, isAdmin } from "@/lib/auth";

export default async function DispatchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireUserAndProfile();
  return (
    <div className="flex h-screen">
      <AppSidebar email={user?.email} isAdmin={isAdmin(profile)} active="dispatch" />
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
