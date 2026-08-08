import { AppSidebar } from "@/components/layout/AppSidebar";
import { requireUserAndProfile, isAdmin } from "@/lib/auth";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireUserAndProfile();

  return (
    <div className="flex h-screen">
      <AppSidebar
        email={user?.email}
        isAdmin={isAdmin(profile)}
        active="chat"
        hideMobileNav
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-hidden focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
