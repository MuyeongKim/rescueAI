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
import { Badge } from "@/components/ui/badge";
import { CategoryBadge } from "@/components/learning/CategoryBadge";

export const dynamic = "force-dynamic";

type DocRow = {
  id: number;
  title: string;
  category: string | null;
  difficulty: string | null;
  source_type: string;
  status: string;
  publish_date: string | null;
  chunkCount: number | null;
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
      chunkCount: 12,
    }));
  }
  const admin = createAdminClient();
  const [docsRes, chunksRes] = await Promise.all([
    admin
      .from("documents")
      .select("id, title, category, difficulty, source_type, status, publish_date")
      .order("created_at", { ascending: false }),
    admin.from("chunks").select("document_id"),
  ]);
  const counts = new Map<number, number>();
  for (const c of chunksRes.data ?? []) {
    if (c.document_id != null)
      counts.set(c.document_id, (counts.get(c.document_id) ?? 0) + 1);
  }
  return (docsRes.data ?? []).map((d) => ({
    ...d,
    chunkCount: counts.get(d.id) ?? 0,
  }));
}

export default async function AdminDocumentsPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const docs = await loadDocuments();

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">자료 관리</h1>
        <p className="text-sm text-muted-foreground">
          인덱싱된 교육자료와 처리 상태를 확인합니다.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">자료 추가 방법</CardTitle>
          <CardDescription>
            PDF를 <code className="rounded bg-muted px-1">docs/&lt;분야&gt;/</code> 폴더에 넣고
            인덱서를 실행하면 자료·과정이 자동 등록됩니다:{" "}
            <code className="rounded bg-muted px-1">
              cd indexing && python embed_and_upload.py
            </code>{" "}
            (웹 업로드 UI는 추후 제공 예정)
          </CardDescription>
        </CardHeader>
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
                <TableHead className="hidden sm:table-cell text-right">청크</TableHead>
                <TableHead className="text-right">상태</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    인덱싱된 자료가 없습니다. 위 안내대로 자료를 추가하세요.
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
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">
                      {d.chunkCount ?? "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.status === "processed" ? (
                        <Badge variant="secondary">처리됨</Badge>
                      ) : d.status === "processing" ? (
                        <Badge variant="outline">처리중</Badge>
                      ) : (
                        <Badge variant="destructive">실패</Badge>
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
