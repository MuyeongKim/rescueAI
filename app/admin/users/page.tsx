import { redirect } from "next/navigation";
import { Users } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, demoUsers } from "@/lib/demo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserRoleSelect } from "@/components/admin/UserRoleSelect";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

type UserRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  division: string | null;
  created_at: string;
};

async function loadUsers(): Promise<UserRow[]> {
  if (DEMO) return demoUsers;
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, email, full_name, role, division, created_at")
    .order("created_at", { ascending: true });
  return (data ?? []) as UserRow[];
}

export default async function AdminUsersPage() {
  const { user, profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const users = await loadUsers();

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <OperationalHeader
        eyebrow="관리 업무 · 사용자"
        title="사용자 관리"
        description="계정 목록과 권한을 관리합니다. 명단 일괄 등록은 관리자 스크립트로 처리합니다."
        icon={Users}
        status={`${users.length}명 등록`}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" /> 전체 사용자 {users.length}명
          </CardTitle>
          <CardDescription>본인 계정의 권한은 변경할 수 없습니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead className="hidden sm:table-cell">이메일</TableHead>
                <TableHead>소속</TableHead>
                <TableHead className="hidden sm:table-cell">가입일</TableHead>
                <TableHead className="text-right">권한</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    등록된 사용자가 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.full_name ?? "이름 미등록"}
                      {u.id === user?.id && (
                        <span className="ml-1.5 text-xs text-muted-foreground">(나)</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell max-w-0 truncate text-muted-foreground">
                      {u.email}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.division ?? "-"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {u.created_at.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <UserRoleSelect
                          userId={u.id}
                          role={u.role}
                          disabled={u.id === user?.id}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
