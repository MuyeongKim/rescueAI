"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  Copy,
  CopyPlus,
  Download,
  FileText,
  Loader2,
  Pencil,
  Presentation,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  GEN_TYPES,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type SavedMaterial,
} from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

function kindLabel(kind: string): string {
  return GEN_TYPES.find((t) => t.key === kind)?.label ?? kind;
}
function kindIcon(kind: string) {
  return kind === "notebooklm" ? Sparkles : kind === "slides" ? Presentation : FileText;
}
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

type DocContent = { sections?: GeneratedDoc["sections"]; sources?: GeneratedDoc["sources"] };
type DeckContent = { slides?: GeneratedSlideDeck["slides"]; sources?: GeneratedSlideDeck["sources"] };
type NlmContent = { prompt?: string };

export function SavedList({
  initial,
  mode = "own",
}: {
  initial: SavedMaterial[];
  /** own: 내 자료(편집·삭제·공유토글) / shared: 공유 갤러리(읽기전용·복제) */
  mode?: "own" | "shared";
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function handleDownload(it: SavedMaterial) {
    setBusyId(it.id);
    try {
      if (it.kind === "slides") {
        const c = it.content as DeckContent;
        const deck: GeneratedSlideDeck = {
          title: it.title,
          slides: c.slides ?? [],
          sources: c.sources ?? [],
        };
        const { downloadPptx } = await import("@/lib/pptx");
        await downloadPptx(
          deck,
          it.category ?? "",
          `대상: ${it.audience ?? "-"} · 교육 시간: ${it.duration ?? "-"}`
        );
      } else if (it.kind === "notebooklm") {
        await navigator.clipboard.writeText((it.content as NlmContent).prompt ?? "");
        toast.success("프롬프트를 복사했습니다");
      } else {
        const c = it.content as DocContent;
        const doc: GeneratedDoc = {
          title: it.title,
          sections: c.sections ?? [],
          sources: c.sources ?? [],
        };
        // 미니서버(hwp-writer-api) 우선, 실패 시 로컬 생성 폴백
        const { downloadHwpx } = await import("@/lib/hwpx-download");
        if ((await downloadHwpx(doc)) === "local") {
          toast.info("한글 작성 서버 미연결 — 기본 양식으로 생성했습니다");
        }
      }
    } catch {
      toast.error("다운로드에 실패했습니다");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("이 자료를 삭제할까요? 되돌릴 수 없습니다.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/generate/save?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("삭제에 실패했습니다");
        return;
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
      if (openId === id) setOpenId(null);
      toast.success("삭제했습니다");
    } catch {
      toast.error("삭제 중 오류가 발생했습니다");
    } finally {
      setBusyId(null);
    }
  }

  // 내 자료 공유/해제 토글
  async function toggleShare(it: SavedMaterial) {
    setBusyId(it.id);
    const next = !it.shared;
    try {
      const res = await fetch("/api/generate/save", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, shared: next }),
      });
      if (!res.ok) {
        toast.error(await res.text());
        return;
      }
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, shared: next } : x)));
      toast.success(next ? "공유했습니다. 동료가 볼 수 있어요." : "공유를 해제했습니다.");
    } catch {
      toast.error("네트워크 오류로 변경하지 못했습니다.");
    } finally {
      setBusyId(null);
    }
  }

  // 공유 자료를 내 자료로 복제(편집 가능하게)
  async function cloneToMine(it: SavedMaterial) {
    setBusyId(it.id);
    try {
      const res = await fetch("/api/generate/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: it.kind,
          category: it.category,
          audience: it.audience,
          duration: it.duration,
          topic: it.topic,
          title: it.title,
          content: it.content,
        }),
      });
      if (!res.ok) {
        toast.error("복제에 실패했습니다");
        return;
      }
      toast.success("내 자료로 복제했습니다. ‘저장한 자료’에서 편집할 수 있어요.");
    } catch {
      toast.error("네트워크 오류로 복제하지 못했습니다");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      {items.map((it) => {
        const Icon = kindIcon(it.kind);
        const st = categoryStyle(it.category);
        const open = openId === it.id;
        const busy = busyId === it.id;
        return (
          <Card
            key={it.id}
            className="animate-in fade-in overflow-hidden border-border/60 shadow-sm duration-300"
          >
            <div className="h-1 w-full" style={{ backgroundColor: st.hex }} />
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start gap-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${st.hex}1a`, color: st.hex }}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{it.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-normal">
                      {kindLabel(it.kind)}
                    </Badge>
                    {it.category && (
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: st.hex }}
                        />
                        {it.category}
                      </Badge>
                    )}
                    {mode === "shared" && it.author_name && (
                      <span className="text-muted-foreground">· {it.author_name}</span>
                    )}
                    <span>{formatDate(it.created_at)}</span>
                    {mode === "own" && it.shared && (
                      <Badge variant="secondary" className="gap-1 font-normal text-primary">
                        <Share2 className="h-3 w-3" /> 공유 중
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setOpenId(open ? null : it.id)}
                >
                  <ChevronDown
                    className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
                  />
                  {open ? "접기" : "열어보기"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => handleDownload(it)}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : it.kind === "notebooklm" ? (
                    <Copy className="h-4 w-4" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {it.kind === "notebooklm"
                    ? "프롬프트 복사"
                    : it.kind === "slides"
                      ? "PPTX"
                      : "한글(hwpx)"}
                </Button>
                {mode === "own" && it.kind !== "notebooklm" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => router.push(`/generate?m=${it.id}`)}
                  >
                    <Pencil className="h-4 w-4" /> 편집
                  </Button>
                )}
                {mode === "shared" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => cloneToMine(it)}
                  >
                    <CopyPlus className="h-4 w-4" /> 내 자료로 복제
                  </Button>
                )}
                {mode === "own" && (
                  <>
                    <Button
                      type="button"
                      variant={it.shared ? "secondary" : "outline"}
                      size="sm"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => toggleShare(it)}
                    >
                      <Share2 className="h-4 w-4" /> {it.shared ? "공유 해제" : "공유"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto gap-1.5 text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => handleDelete(it.id)}
                    >
                      <Trash2 className="h-4 w-4" /> 삭제
                    </Button>
                  </>
                )}
              </div>

              {open && (
                <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t pt-3 text-sm duration-200">
                  {it.kind === "slides" ? (
                    ((it.content as DeckContent).slides ?? []).map((s, i) => (
                      <div key={i}>
                        <p className="flex items-baseline gap-2 font-semibold">
                          <span className="text-xs text-muted-foreground">{i + 1}</span>
                          {s.title}
                        </p>
                        <ul className="list-disc space-y-0.5 pl-6 text-muted-foreground">
                          {s.bullets.map((b, j) => (
                            <li key={j}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    ))
                  ) : it.kind === "notebooklm" ? (
                    <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-relaxed">
                      {(it.content as NlmContent).prompt}
                    </pre>
                  ) : (
                    ((it.content as DocContent).sections ?? []).map((s, i) => (
                      <section key={i}>
                        <h3 className="font-semibold">{s.heading}</h3>
                        <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                          {s.content}
                        </p>
                      </section>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
