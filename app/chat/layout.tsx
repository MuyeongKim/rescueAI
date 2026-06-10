import { AppSidebar } from "@/components/layout/AppSidebar";
import { getUserAndProfile, isAdmin } from "@/lib/auth";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getUserAndProfile();

  return (
    <div className="flex h-screen">
      <AppSidebar
        email={user?.email}
        isAdmin={isAdmin(profile)}
        active="chat"
        hideMobileNav
      />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
