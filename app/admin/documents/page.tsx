import { redirect } from "next/navigation";
import { FileText } from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, demoDocuments } from "@/lib/demo";
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
import { CategoryBadge } from "@/components/learning/CategoryBadge";
import { DocumentUpload } from "@/components/admin/DocumentUpload";
import { DocumentDeleteButton } from "@/components/admin/DocumentDeleteButton";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

type DocRow = {
  id: number;
  title: string;
  category: string | null;
  difficulty: string | null;
  source_type: string;
  status: string;
  publish_date: string | null;
};

async function loadDocuments(): Promise<DocRow[]> {
  if (DEMO) {
    return demoDocuments.map((d) => ({
      id: d.id,
      title: d.title,
      category: d.category,
      difficulty: d.difficulty,
      source_type: d.source_type,
      status: "processed",
      publish_date: d.publish_date,
    }));
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("documents")
    .select("id, title, category, difficulty, source_type, status, publish_date")
    .order("created_at", { ascending: false });
  return data ?? [];
}

export default async function AdminDocumentsPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const docs = await loadDocuments();

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <OperationalHeader
        eyebrow="관리 업무 · 근거 자료"
        title="자료 관리"
        description="인덱싱된 교육자료와 처리 상태를 확인합니다."
        icon={FileText}
        status={`${docs.length}건 등록`}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">원본 자료 업로드</CardTitle>
          <CardDescription>
            대원이 자료실(<code className="rounded bg-muted px-1">/docs</code>)에서 열람할 원본
            PDF를 올립니다. 비공개로 저장되며 로그인한 대원만 열람할 수 있습니다.
            <br />※ AI 튜터의 검색 근거(벡터)는 별도 인덱싱(rag7.py)으로 적재됩니다 — 이 업로드와 무관.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUpload />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" /> 전체 자료 {docs.length}건
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>제목</TableHead>
                <TableHead>분야</TableHead>
                <TableHead className="hidden sm:table-cell">난이도</TableHead>
                <TableHead className="hidden sm:table-cell">발행일</TableHead>
                <TableHead className="w-12 text-right">삭제</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    등록된 자료가 없습니다. 위에서 PDF를 업로드하세요.
                  </TableCell>
                </TableRow>
              ) : (
                docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-0 truncate font-medium">{d.title}</TableCell>
                    <TableCell>
                      <CategoryBadge category={d.category} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {d.difficulty ?? "-"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {d.publish_date ?? "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DocumentDeleteButton id={d.id} title={d.title} />
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
