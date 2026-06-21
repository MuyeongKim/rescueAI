"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronDown,
  Copy,
  Download,
  FileText,
  Loader2,
  Pencil,
  Presentation,
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

export function SavedList({ initial }: { initial: SavedMaterial[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

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
        const { buildHwpxBlob } = await import("@/lib/hwpx");
        downloadBlob(await buildHwpxBlob(doc), `${doc.title.slice(0, 50)}.hwpx`);
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
                    <span>{formatDate(it.created_at)}</span>
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
                {it.kind !== "notebooklm" && (
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
