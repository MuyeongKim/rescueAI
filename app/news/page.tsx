import { Newspaper } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NEWS_ITEMS } from "@/lib/news";

export const dynamic = "force-dynamic";

export default function NewsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Newspaper className="h-5 w-5 text-primary" /> 구조 동향
        </h1>
        <p className="text-sm text-muted-foreground">
          전국·해외 구조 사례와 신기술 동향입니다. 매일 아침 자동
          수집·요약됩니다(예정).
        </p>
      </div>

      <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        ⚠️ 예시 데이터입니다 — 뉴스 자동 수집(검색 API + 매일 아침 게시) 연동
        예정입니다.
      </p>

      <div className="space-y-3">
        {NEWS_ITEMS.map((n) => (
          <Card key={n.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={n.region === "해외" ? "default" : "secondary"}>
                  {n.region}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {n.category}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {n.date}
                </span>
              </div>
              <CardTitle className="text-base leading-snug">{n.title}</CardTitle>
              <CardDescription>{n.source}</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {n.summary}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
