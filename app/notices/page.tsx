import { Pin } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { isNewNotice } from "@/lib/notices";
import { DEMO, demoNotices } from "@/lib/demo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const dynamic = "force-dynamic";

type Notice = {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  created_at: string;
};

async function loadNotices(): Promise<Notice[]> {
  if (DEMO) return demoNotices;
  const supabase = await createClient();
  const { data } = await supabase
    .from("notices")
    .select("id, title, content, pinned, created_at")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []) as Notice[];
}

export default async function NoticesPage() {
  const notices = await loadNotices();

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">공지사항</h1>
        <p className="text-sm text-muted-foreground">
          교육·훈련 관련 공지를 확인하세요.
        </p>
      </div>

      {notices.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            등록된 공지사항이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <Accordion type="single" collapsible className="rounded-xl border bg-card px-4">
          {notices.map((n) => (
            <AccordionItem key={n.id} value={String(n.id)}>
              <AccordionTrigger className="gap-2 text-left">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {n.pinned && (
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      <Pin className="h-3 w-3" /> 고정
                    </Badge>
                  )}
                  <span className="truncate font-medium">{n.title}</span>
                  {isNewNotice(n.created_at) && (
                    <span className="shrink-0 text-[10px] font-bold text-primary">
                      NEW
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                    {n.created_at.slice(0, 10)}
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="whitespace-pre-wrap text-[15px] leading-relaxed">
                {n.content}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}
