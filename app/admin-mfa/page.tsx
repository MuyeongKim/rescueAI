import type { Metadata } from "next";
import { requireAdminMfaSetup } from "@/lib/auth";
import { AdminMfaForm } from "@/components/admin/AdminMfaForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "관리자 추가 인증 | RescueAI",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function AdminMfaPage() {
  await requireAdminMfaSetup();
  return <AdminMfaForm />;
}
