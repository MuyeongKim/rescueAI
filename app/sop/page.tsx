import { ClipboardCheck, MessageSquare } from "lucide-react";
import Link from "next/link";

import { SOP_TYPES } from "@/lib/sop";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// 현장 SOP 요약 — 출동 종별 핵심 수칙. 검색·대기 없이 즉시 열람(태블릿·모바일 우선).
export default function SopPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ClipboardCheck className="h-5 w-5 text-primary" /> 현장 SOP 요약
        </h1>
        <p className="text-sm text-muted-foreground">
          출동 종별 핵심 수칙을 단계별로 빠르게 확인합니다. 상세 절차는 AI
          튜터에게 물어보세요.
        </p>
      </div>

      <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        ⚠️ 예시 콘텐츠입니다 — SOP 자료 인덱싱·검증 후 실제 수칙으로 교체됩니다.
      </p>

      <Accordion type="single" collapsible className="space-y-2">
        {SOP_TYPES.map((t) => (
          <AccordionItem
            key={t.key}
            value={t.key}
            className="rounded-lg border px-4 last:border-b"
          >
            <AccordionTrigger className="py-4 text-base hover:no-underline">
              <span className="flex items-center gap-3">
                <span className="text-xl" aria-hidden>
                  {t.emoji}
                </span>
                <span className="text-left">
                  <span className="block font-semibold">{t.label}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t.summary}
                  </span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3 pb-4">
              {t.phases.map((p) => (
                <div key={p.phase}>
                  <Badge variant="secondary" className="mb-1.5">
                    {p.phase}
                  </Badge>
                  <ul className="space-y-1.5">
                    {p.items.map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm leading-relaxed">
                        <span className="mt-0.5 shrink-0 text-primary">✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <Link
                href={`/chat?q=${encodeURIComponent(`${t.label} 출동 시 SOP 상세 절차 알려줘`)}`}
                className="block pt-1"
              >
                <Button variant="outline" className="h-11 w-full gap-2">
                  <MessageSquare className="h-4 w-4" /> AI 튜터에게 {t.label} 상세
                  절차 묻기
                </Button>
              </Link>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          현장에서는 본 요약보다 <strong>현장 지휘관 지시</strong>와{" "}
          <strong>공식 SOP 원문</strong>이 우선합니다.
        </CardContent>
      </Card>
    </div>
  );
}
