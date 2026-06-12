import { AppSidebar } from "@/components/layout/AppSidebar";
import { getUserAndProfile, isAdmin } from "@/lib/auth";

export default async function NewsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await getUserAndProfile();
  return (
    <div className="flex h-screen">
      <AppSidebar email={user?.email} isAdmin={isAdmin(profile)} active="news" />
      <main className="flex-1 overflow-auto pb-14 md:pb-0">{children}</main>
    </div>
  );
}
