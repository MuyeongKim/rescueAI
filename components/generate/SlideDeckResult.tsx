"use client";

// 슬라이드(PPTX) 결과 카드 — 미리보기 · 항목 편집 · 항목별 AI 재생성 · PPTX 다운로드.
import { Download, Presentation } from "lucide-react";

import type { GeneratedSlide, GeneratedSlideDeck } from "@/lib/generate";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AccentBar,
  EditToggleButton,
  RegenControls,
  SaveButton,
  SourceBadges,
  type RegenState,
  type ResultChrome,
} from "@/components/generate/parts";

export function SlideDeckResult({
  deck,
  chrome,
  regen,
  onTitleChange,
  onPatchSlide,
  onPatchBullet,
  onDownloadPptx,
}: {
  deck: GeneratedSlideDeck;
  chrome: ResultChrome;
  regen: RegenState;
  onTitleChange: (title: string) => void;
  onPatchSlide: (index: number, patch: Partial<GeneratedSlide>) => void;
  onPatchBullet: (slideIndex: number, bulletIndex: number, value: string) => void;
  onDownloadPptx: () => void;
}) {
  const { accent, editing } = chrome;

  return (
    <Card
      className={cn(
        "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
        editing && "ring-1 ring-primary/40"
      )}
    >
      <AccentBar accent={accent} />
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          {editing ? (
            <Input
              value={deck.title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="h-9 text-base font-semibold"
              aria-label="발표 제목"
            />
          ) : (
            <CardTitle className="flex items-center gap-2 text-base">
              <Presentation className="h-4 w-4" style={{ color: accent }} /> {deck.title}
            </CardTitle>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            <SaveButton chrome={chrome} />
            <EditToggleButton chrome={chrome} />
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          슬라이드 {deck.slides.length}장 · 근거:
          <SourceBadges sources={deck.sources} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {deck.slides.map((s, i) => (
            <div key={i} className="rounded-lg border p-3">
              {editing ? (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground">{i + 1}</span>
                    <Input
                      value={s.title}
                      onChange={(e) => onPatchSlide(i, { title: e.target.value })}
                      className="h-9 font-semibold"
                      aria-label={`슬라이드 ${i + 1} 제목`}
                    />
                  </div>
                  <div className="space-y-1 pl-5">
                    {s.bullets.map((b, j) => (
                      <Input
                        key={j}
                        value={b}
                        onChange={(e) => onPatchBullet(i, j, e.target.value)}
                        className="h-9 text-sm"
                        aria-label={`슬라이드 ${i + 1} 항목 ${j + 1}`}
                      />
                    ))}
                  </div>
                  <Textarea
                    value={s.notes}
                    onChange={(e) => onPatchSlide(i, { notes: e.target.value })}
                    className="min-h-[60px] text-xs"
                    aria-label={`슬라이드 ${i + 1} 발표자 노트`}
                    placeholder="발표자 노트"
                  />
                  <RegenControls index={i} regen={regen} />
                </div>
              ) : (
                <>
                  <p className="mb-1 flex items-baseline gap-2 font-semibold">
                    <span className="text-xs text-muted-foreground">{i + 1}</span>
                    {s.title}
                  </p>
                  {s.steps && s.steps.length >= 2 && (
                    <div className="mb-2 flex flex-wrap items-center gap-1 pl-5 text-xs">
                      {s.steps.map((st, k) => (
                        <span key={k} className="flex items-center gap-1">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{st}</span>
                          {k < s.steps!.length - 1 && (
                            <span className="text-muted-foreground">▸</span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                    {s.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                  {s.notes && (
                    <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                      🎤 {s.notes}
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <Button className="h-12 w-full gap-2 text-base" onClick={onDownloadPptx}>
          <Download className="h-4 w-4" /> PPTX 다운로드 (발표자 노트 포함)
        </Button>
        <p className="text-xs text-muted-foreground">
          분야 색 표준 양식으로 만들어집니다. AI가 인덱싱된 교육자료를 근거로 생성한 초안이므로
          시행 전 내용을 반드시 검토·보완하세요.
        </p>
      </CardContent>
    </Card>
  );
}
