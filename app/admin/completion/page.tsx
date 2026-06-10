import { redirect } from "next/navigation";
import { Award, Building2 } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, demoCompletionUsers } from "@/lib/demo";
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
import { Badge } from "@/components/ui/badge";
import { CategoryBadge } from "@/components/learning/CategoryBadge";
import { DownloadCsvButton } from "@/components/admin/DownloadCsvButton";

export const dynamic = "force-dynamic";

type UserCompletion = {
  id: string;
  full_name: string | null;
  email: string | null;
  division: string | null;
  lessonsDone: number;
  passedCategories: string[];
};

// 전 사용자의 학습·이수 현황을 조립한다 (관리자 검증 후 service role).
async function loadCompletion(): Promise<UserCompletion[]> {
  if (DEMO) return demoCompletionUsers;
  const admin = createAdminClient();

  const [profilesRes, progressRes, quizRes] = await Promise.all([
    admin
      .from("profiles")
      .select("id, full_name, email, division")
      .order("division", { ascending: true }),
    admin.from("lesson_progress").select("user_id"),
    admin
      .from("quiz_attempts")
      .select("user_id, category")
      .eq("passed", true),
  ]);

  const lessonCount = new Map<string, number>();
  for (const p of progressRes.data ?? []) {
    if (p.user_id)
      lessonCount.set(p.user_id, (lessonCount.get(p.user_id) ?? 0) + 1);
  }
  const passed = new Map<string, Set<string>>();
  for (const q of quizRes.data ?? []) {
    if (!q.user_id || !q.category) continue;
    if (!passed.has(q.user_id)) passed.set(q.user_id, new Set());
    passed.get(q.user_id)!.add(q.category);
  }

  return (profilesRes.data ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    division: p.division,
    lessonsDone: lessonCount.get(p.id) ?? 0,
    passedCategories: Array.from(passed.get(p.id) ?? []),
  }));
}

export default async function AdminCompletionPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const users = await loadCompletion();

  // 소속별 요약
  const byDivision = new Map<string, UserCompletion[]>();
  for (const u of users) {
    const key = u.division ?? "소속 미지정";
    if (!byDivision.has(key)) byDivision.set(key, []);
    byDivision.get(key)!.push(u);
  }
  const divisionRows = Array.from(byDivision.entries())
    .map(([division, members]) => {
      const certified = members.filter((m) => m.passedCategories.length > 0);
      return {
        division,
        count: members.length,
        lessons: members.reduce((s, m) => s + m.lessonsDone, 0),
        completions: members.reduce((s, m) => s + m.passedCategories.length, 0),
        certifiedRate: Math.round((certified.length / members.length) * 100),
      };
    })
    .sort((a, b) => b.certifiedRate - a.certifiedRate);

  const csvHeader = ["이름", "이메일", "소속", "레슨 완료", "이수 과정 수", "이수 과정"];
  const csvRows = users.map((u) => [
    u.full_name ?? "",
    u.email ?? "",
    u.division ?? "",
    u.lessonsDone,
    u.passedCategories.length,
    u.passedCategories.join(" · "),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">이수 현황</h1>
          <p className="text-sm text-muted-foreground">
            소속별·개인별 학습 이수 현황입니다. 보고용 명단은 CSV로 내려받으세요.
          </p>
        </div>
        <DownloadCsvButton
          header={csvHeader}
          rows={csvRows}
          filename={`이수현황_${today}.csv`}
        />
      </div>

      {/* 소속별 요약 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" /> 소속별 요약
          </CardTitle>
          <CardDescription>이수자 = 1개 이상 과정을 이수한 대원</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>소속</TableHead>
                <TableHead className="text-right">인원</TableHead>
                <TableHead className="hidden sm:table-cell text-right">레슨 완료</TableHead>
                <TableHead className="text-right">과정 이수</TableHead>
                <TableHead className="text-right">이수자 비율</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {divisionRows.map((d) => (
                <TableRow key={d.division}>
                  <TableCell className="font-medium">{d.division}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.count}명</TableCell>
                  <TableCell className="hidden sm:table-cell text-right tabular-nums">
                    {d.lessons}건
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{d.completions}건</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {d.certifiedRate}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 개인별 현황 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="h-4 w-4" /> 개인별 현황 {users.length}명
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>소속</TableHead>
                <TableHead className="hidden sm:table-cell text-right">레슨 완료</TableHead>
                <TableHead>이수 과정</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    등록된 사용자가 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.full_name ?? "이름 미등록"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.division ?? "-"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">
                      {u.lessonsDone}건
                    </TableCell>
                    <TableCell>
                      {u.passedCategories.length === 0 ? (
                        <Badge variant="outline">미이수</Badge>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {u.passedCategories.map((c) => (
                            <CategoryBadge key={c} category={c} />
                          ))}
                        </span>
                      )}
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
