import { Newspaper } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OperationalHeader } from "@/components/layout/OperationalHeader";
import { listVisibleNews } from "@/lib/news";

export const dynamic = "force-dynamic";

export default async function NewsPage() {
  const items = await listVisibleNews();

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="현장 정보 · 구조 동향"
        title="구조 동향"
        description="전국·해외 구조 사례와 신기술 동향을 확인합니다."
        icon={Newspaper}
        status={`${items.length}건 게시`}
      />

      {items.length === 0 ? (
        <p className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          아직 등록된 동향이 없습니다. 관리자 &gt; 동향 관리에서 추가하거나 자동
          수집을 실행하세요.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((n) => {
            const card = (
              <Card
                key={n.id}
                className={n.url ? "border-l-4 border-l-slate-300 transition-colors hover:border-l-primary" : "border-l-4 border-l-slate-300"}
              >
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {n.region && (
                      <Badge variant={n.region === "해외" ? "default" : "secondary"}>
                        {n.region}
                      </Badge>
                    )}
                    {n.category && (
                      <Badge variant="outline" className="font-normal">
                        {n.category}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {n.date}
                    </span>
                  </div>
                  <CardTitle className="text-base leading-snug">{n.title}</CardTitle>
                  {n.source && <CardDescription>{n.source}</CardDescription>}
                </CardHeader>
                {n.summary && (
                  <CardContent className="pt-0">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {n.summary}
                    </p>
                  </CardContent>
                )}
              </Card>
            );
            // 원문 링크가 있으면 새 탭으로 열기
            return n.url ? (
              <a
                key={n.id}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                {card}
              </a>
            ) : (
              card
            );
          })}
        </div>
      )}
    </div>
  );
}
