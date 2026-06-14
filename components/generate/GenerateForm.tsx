"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  MessageSquareText,
  Presentation,
  Sparkles,
  Wand2,
} from "lucide-react";

import {
  AUDIENCES,
  DURATIONS,
  GEN_TYPES,
  buildNotebookLmPrompt,
  type Audience,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// 선택형 옵션 버튼 그룹 (터치 48px+)
function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <Button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            variant={value === opt ? "default" : "outline"}
            className="h-12 px-4 text-base"
            onClick={() => onChange(opt)}
          >
            {render ? render(opt) : opt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function docToText(doc: GeneratedDoc): string {
  const body = doc.sections
    .map((s) => `${s.heading}\n${s.content}`)
    .join("\n\n");
  const sources = doc.sources.length
    ? `\n\n[근거 자료]\n${doc.sources
        .map((s) => `- ${s.doc}${s.page != null ? ` p.${s.page}` : ""}`)
        .join("\n")}`
    : "";
  return `${doc.title}\n\n${body}${sources}`;
}

export function GenerateForm({
  docsByCategory,
  models = [],
}: {
  docsByCategory: Record<string, string[]>;
  models?: { key: string; label: string; note?: string }[];
}) {
  const categories = Object.keys(docsByCategory);
  const [type, setType] = useState<GenType>("plan");
  const [category, setCategory] = useState<string>(categories[0] ?? "");
  const [audience, setAudience] = useState<Audience>("일반 대원");
  const [duration, setDuration] = useState<Duration>("2시간");
  const [topic, setTopic] = useState("");
  const [date, setDate] = useState("");
  const [model, setModel] = useState<string>(models[0]?.key ?? "");
  const [loading, setLoading] = useState(false);
  const [doc, setDoc] = useState<GeneratedDoc | null>(null);
  const [deck, setDeck] = useState<GeneratedSlideDeck | null>(null);
  const [nlmPrompt, setNlmPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const genReq = { type, category, audience, duration, topic, date, model };
  const subtitle = `대상: ${audience} · 교육 시간: ${duration}${date ? ` · ${date}` : ""}`;

  async function handleGenerate() {
    setCopied(false);
    setDoc(null);
    setDeck(null);
    setNlmPrompt(null);

    // NotebookLM 프롬프트는 AI 호출 없이 즉시 조립 — 인덱싱된 자료 목록 포함
    if (type === "notebooklm") {
      setNlmPrompt(buildNotebookLmPrompt(genReq, docsByCategory[category] ?? []));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(genReq),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error("생성 실패", {
          description: err?.error ?? "잠시 후 다시 시도해 주세요.",
        });
        return;
      }
      const json = await res.json();
      if (type === "slides") setDeck(json as GeneratedSlideDeck);
      else setDoc(json as GeneratedDoc);
    } catch {
      toast.error("생성 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePptx() {
    if (!deck) return;
    try {
      // pptxgenjs는 무거워서 다운로드 시점에만 로드
      const { downloadPptx } = await import("@/lib/pptx");
      await downloadPptx(deck, category, subtitle);
    } catch {
      toast.error("PPTX 파일 생성에 실패했습니다");
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("복사했습니다");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("복사에 실패했습니다");
    }
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDocx() {
    if (!doc) return;
    try {
      // docx는 무거워서 다운로드 시점에만 로드
      const { buildDocxBlob } = await import("@/lib/docx");
      downloadBlob(await buildDocxBlob(doc), `${doc.title.slice(0, 50)}.docx`);
    } catch {
      toast.error("문서 파일 생성에 실패했습니다");
    }
  }

  async function handleHwpx() {
    if (!doc) return;
    try {
      // hwpx 빌더도 다운로드 시점에만 로드
      const { buildHwpxBlob } = await import("@/lib/hwpx");
      downloadBlob(await buildHwpxBlob(doc), `${doc.title.slice(0, 50)}.hwpx`);
    } catch {
      toast.error("한글 파일 생성에 실패했습니다");
    }
  }

  const typeMeta = GEN_TYPES.find((t) => t.key === type)!;

  return (
    <div className="space-y-5">
      {/* 1. 무엇을 만들까요 */}
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-5">
          <div className="space-y-2">
            <Label className="text-sm font-medium">생성할 자료</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
              {GEN_TYPES.map((t) => {
                const Icon =
                  t.key === "notebooklm"
                    ? Sparkles
                    : t.key === "slides"
                      ? Presentation
                      : t.key === "lesson"
                        ? MessageSquareText
                        : FileText;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={type === t.key}
                    onClick={() => setType(t.key)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors min-h-[48px]",
                      type === t.key
                        ? "border-primary bg-primary/5"
                        : "hover:border-primary/40 hover:bg-accent/40"
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <Icon className="h-4 w-4 text-primary" />
                      {t.label}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <OptionGroup
            label="분야"
            options={categories}
            value={category}
            onChange={setCategory}
            render={(c) => (
              <span className="flex items-center gap-1.5">
                <span className={cn("h-2 w-2 rounded-full", categoryStyle(c).dot)} />
                {c}
              </span>
            )}
          />
          <OptionGroup label="대상" options={AUDIENCES} value={audience} onChange={setAudience} />
          <OptionGroup label="교육 시간" options={DURATIONS} value={duration} onChange={setDuration} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="topic" className="text-sm font-medium">
                훈련 내용(주제){" "}
                <span className="font-normal text-muted-foreground">(선택)</span>
              </Label>
              <Input
                id="topic"
                placeholder="예: 공기호흡기 점검 절차"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={100}
                className="h-12 text-base"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="date" className="text-sm font-medium">
                훈련 일자{" "}
                <span className="font-normal text-muted-foreground">(선택)</span>
              </Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-12 text-base"
              />
            </div>
          </div>

          {/* AI 모델 선택 — 2개 이상 사용 가능할 때만. NotebookLM은 AI를 안 쓰므로 숨김 */}
          {type !== "notebooklm" && models.length > 1 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">AI 모델</Label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="AI 모델">
                {models.map((m) => (
                  <Button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={model === m.key}
                    variant={model === m.key ? "default" : "outline"}
                    className="h-12 flex-col items-start gap-0 px-4 py-1.5"
                    onClick={() => setModel(m.key)}
                  >
                    <span className="text-sm font-medium">{m.label}</span>
                    {m.note && (
                      <span className="text-[11px] font-normal opacity-70">{m.note}</span>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <Button
            className="h-12 w-full gap-2 text-base"
            onClick={handleGenerate}
            disabled={loading || !category}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            {loading ? "생성 중… (수십 초 걸릴 수 있어요)" : `${typeMeta.label} 생성`}
          </Button>
        </CardContent>
      </Card>

      {/* 2-a. NotebookLM 프롬프트 결과 */}
      {nlmPrompt && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> NotebookLM 프롬프트
            </CardTitle>
            <CardDescription>
              NotebookLM에 교육자료를 업로드한 뒤, 아래 프롬프트를 붙여넣으세요.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm leading-relaxed">
              {nlmPrompt}
            </pre>
            <Button
              variant="outline"
              className="h-12 w-full gap-2 text-base"
              onClick={() => handleCopy(nlmPrompt)}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              프롬프트 복사
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 2-b. 슬라이드 결과 — 표준 양식(분야 색) PPTX로 변환 */}
      {deck && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Presentation className="h-4 w-4 text-primary" /> {deck.title}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-1.5">
              슬라이드 {deck.slides.length}장 · 근거:
              {deck.sources.map((s, i) => (
                <Badge key={i} variant="secondary" className="font-normal">
                  {s.doc}
                  {s.page != null && ` p.${s.page}`}
                </Badge>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
              {deck.slides.map((s, i) => (
                <div key={i} className="rounded-lg border p-3">
                  <p className="mb-1 flex items-baseline gap-2 font-semibold">
                    <span className="text-xs text-muted-foreground">{i + 1}</span>
                    {s.title}
                  </p>
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
                </div>
              ))}
            </div>
            <Button className="h-12 w-full gap-2 text-base" onClick={handlePptx}>
              <Download className="h-4 w-4" /> PPTX 다운로드 (발표자 노트 포함)
            </Button>
            <p className="text-xs text-muted-foreground">
              분야 색 표준 양식으로 만들어집니다. AI가 인덱싱된 교육자료를 근거로 생성한
              초안이므로 시행 전 내용을 반드시 검토·보완하세요.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 2-c. 생성 문서 결과 */}
      {doc && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{doc.title}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-1.5">
              근거:
              {doc.sources.map((s, i) => (
                <Badge key={i} variant="secondary" className="font-normal">
                  {s.doc}
                  {s.page != null && ` p.${s.page}`}
                </Badge>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {doc.sections.map((s, i) => (
              <section key={i}>
                <h3 className="mb-1 font-semibold">{s.heading}</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {s.content}
                </p>
              </section>
            ))}
            <div className="flex flex-col gap-2 pt-2 sm:flex-row">
              <Button className="h-12 flex-1 gap-2 text-base" onClick={handleHwpx}>
                <Download className="h-4 w-4" /> 한글(hwpx) 다운로드
              </Button>
              <Button
                variant="outline"
                className="h-12 flex-1 gap-2 text-base"
                onClick={handleDocx}
              >
                <Download className="h-4 w-4" /> 워드(docx)
              </Button>
              <Button
                variant="outline"
                className="h-12 flex-1 gap-2 text-base"
                onClick={() => handleCopy(docToText(doc))}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                텍스트 복사
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              AI가 인덱싱된 교육자료를 근거로 생성한 초안입니다. 시행 전 내용을 반드시
              검토·보완하세요.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
