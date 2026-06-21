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
  Pencil,
  Presentation,
  RefreshCw,
  Save,
  Sparkles,
  Wand2,
} from "lucide-react";

import {
  AUDIENCES,
  DURATIONS,
  GEN_TYPES,
  REGEN_INSTRUCTIONS,
  buildNotebookLmPrompt,
  type Audience,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedSection,
  type GeneratedSlide,
  type GeneratedSlideDeck,
  type SavedMaterial,
} from "@/lib/generate";
import { categoryStyle } from "@/lib/category";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

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
    <div className="space-y-2.5">
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt)}
              className={cn(
                "inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium transition-all duration-200 motion-reduce:transition-none",
                "hover:-translate-y-0.5 active:translate-y-0 motion-reduce:hover:translate-y-0",
                active
                  ? "border-primary bg-primary text-primary-foreground shadow-sm"
                  : "border-border bg-background hover:border-primary/40 hover:bg-accent/40"
              )}
            >
              {render ? render(opt) : opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 단계 헤더 — 폼은 "유형 → 설정 → 세부 → 생성" 순서가 있는 흐름이라 번호를 단다.
function StepHeader({ n, title, hint }: { n: string; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-xs font-semibold tabular-nums text-primary">{n}</span>
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </div>
  );
}

// 저장본(SavedMaterial)을 폼 결과 상태로 복원한다(재편집 진입).
function hydrateMaterial(m?: SavedMaterial | null): {
  doc: GeneratedDoc | null;
  deck: GeneratedSlideDeck | null;
  nlm: string | null;
} {
  if (!m) return { doc: null, deck: null, nlm: null };
  const c = (m.content ?? {}) as {
    sections?: GeneratedDoc["sections"];
    slides?: GeneratedSlideDeck["slides"];
    sources?: GeneratedDoc["sources"];
    prompt?: string;
  };
  if (m.kind === "slides") {
    return {
      doc: null,
      deck: { title: m.title, slides: c.slides ?? [], sources: c.sources ?? [] },
      nlm: null,
    };
  }
  if (m.kind === "notebooklm") return { doc: null, deck: null, nlm: c.prompt ?? "" };
  return {
    doc: { title: m.title, sections: c.sections ?? [], sources: c.sources ?? [] },
    deck: null,
    nlm: null,
  };
}

const asAudience = (v?: string | null): Audience =>
  AUDIENCES.includes(v as Audience) ? (v as Audience) : "일반 대원";
const asDuration = (v?: string | null): Duration =>
  DURATIONS.includes(v as Duration) ? (v as Duration) : "2시간";

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
  initialMaterial,
}: {
  docsByCategory: Record<string, string[]>;
  models?: { key: string; label: string; note?: string }[];
  initialMaterial?: SavedMaterial; // 저장본 재편집으로 진입 시 복원할 자료
}) {
  const categories = Object.keys(docsByCategory);
  const hydrated = hydrateMaterial(initialMaterial);
  const [type, setType] = useState<GenType>(initialMaterial?.kind ?? "plan");
  const [category, setCategory] = useState<string>(
    initialMaterial?.category ?? categories[0] ?? ""
  );
  const [audience, setAudience] = useState<Audience>(asAudience(initialMaterial?.audience));
  const [duration, setDuration] = useState<Duration>(asDuration(initialMaterial?.duration));
  const [topic, setTopic] = useState(initialMaterial?.topic ?? "");
  const [date, setDate] = useState("");
  const [model, setModel] = useState<string>(models[0]?.key ?? "");
  const [loading, setLoading] = useState(false);
  const [doc, setDoc] = useState<GeneratedDoc | null>(hydrated.doc);
  const [deck, setDeck] = useState<GeneratedSlideDeck | null>(hydrated.deck);
  const [nlmPrompt, setNlmPrompt] = useState<string | null>(hydrated.nlm);
  const [copied, setCopied] = useState(false);
  // 재편집 진입 시 문서/슬라이드는 편집 모드로 연다(프롬프트는 편집 UI 없음).
  const [editing, setEditing] = useState(
    !!initialMaterial && initialMaterial.kind !== "notebooklm"
  );
  const [regenIdx, setRegenIdx] = useState<number | null>(null); // 재생성 패널이 열린 항목
  const [regenLoading, setRegenLoading] = useState<number | null>(null);
  const [regenText, setRegenText] = useState(""); // 직접 입력 지시
  const [resultKind, setResultKind] = useState<GenType | null>(initialMaterial?.kind ?? null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadedId, setLoadedId] = useState<number | null>(initialMaterial?.id ?? null); // 재편집 대상 id

  const genReq = { type, category, audience, duration, topic, date, model };
  const subtitle = `대상: ${audience} · 교육 시간: ${duration}${date ? ` · ${date}` : ""}`;

  // 결과 부분 편집 — 편집 내용은 그대로 다운로드/복사에 반영된다(빌더가 state를 받음).
  function patchSection(i: number, patch: Partial<GeneratedSection>) {
    setSaved(false);
    setDoc((prev) =>
      prev
        ? { ...prev, sections: prev.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : prev
    );
  }
  function patchSlide(i: number, patch: Partial<GeneratedSlide>) {
    setSaved(false);
    setDeck((prev) =>
      prev
        ? { ...prev, slides: prev.slides.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : prev
    );
  }
  function patchBullet(slideI: number, bulletI: number, value: string) {
    setSaved(false);
    setDeck((prev) =>
      prev
        ? {
            ...prev,
            slides: prev.slides.map((s, j) =>
              j === slideI
                ? { ...s, bullets: s.bullets.map((b, k) => (k === bulletI ? value : b)) }
                : s
            ),
          }
        : prev
    );
  }

  // AI 부분 재생성 — 섹션/슬라이드 1개만 다시 생성해 해당 부분만 교체한다.
  async function handleRegen(
    kind: "section" | "slide",
    index: number,
    instruction?: string
  ) {
    const outline =
      kind === "section"
        ? (doc?.sections.map((s) => s.heading) ?? [])
        : (deck?.slides.map((s) => s.title) ?? []);
    const current = kind === "section" ? doc?.sections[index] : deck?.slides[index];
    const docTitle = kind === "section" ? doc?.title : deck?.title;
    if (!current) return;

    setRegenLoading(index);
    try {
      const res = await fetch("/api/generate/section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          category,
          audience,
          duration,
          topic,
          model,
          docTitle,
          outline,
          index,
          current,
          instruction,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error("재생성 실패", {
          description: err?.error ?? "잠시 후 다시 시도해 주세요.",
        });
        return;
      }
      const json = await res.json();
      if (kind === "section") patchSection(index, json as GeneratedSection);
      else patchSlide(index, json as GeneratedSlide);
      toast.success("다시 생성했습니다");
      setRegenIdx(null);
      setRegenText("");
    } catch {
      toast.error("재생성 중 오류가 발생했습니다.");
    } finally {
      setRegenLoading(null);
    }
  }

  // 편집 모드에서 항목별 재생성 컨트롤 (프리셋 + 직접 입력)
  function renderRegen(kind: "section" | "slide", index: number) {
    const isOpen = regenIdx === index;
    const isLoading = regenLoading === index;
    if (!isOpen) {
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-muted-foreground"
          disabled={regenLoading !== null}
          onClick={() => {
            setRegenIdx(index);
            setRegenText("");
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" /> AI로 다시 생성
        </Button>
      );
    }
    return (
      <div className="space-y-2 rounded-md border border-dashed p-2">
        <div className="flex flex-wrap gap-1.5">
          {REGEN_INSTRUCTIONS.map((ins) => (
            <Button
              key={ins.key}
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={isLoading}
              onClick={() => handleRegen(kind, index, ins.text)}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {ins.label}
            </Button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={regenText}
            onChange={(e) => setRegenText(e.target.value)}
            placeholder="직접 지시 (예: 표로 정리)"
            className="h-8 text-xs"
            disabled={isLoading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && regenText.trim())
                handleRegen(kind, index, regenText.trim());
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={isLoading || !regenText.trim()}
            onClick={() => handleRegen(kind, index, regenText.trim())}
          >
            적용
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={isLoading}
            onClick={() => setRegenIdx(null)}
          >
            닫기
          </Button>
        </div>
      </div>
    );
  }

  async function handleGenerate() {
    setCopied(false);
    setEditing(false);
    setRegenIdx(null);
    setSaved(false);
    setResultKind(null);
    setLoadedId(null); // 새 생성은 저장 안 된 새 결과
    setDoc(null);
    setDeck(null);
    setNlmPrompt(null);

    // NotebookLM 프롬프트는 AI 호출 없이 즉시 조립 — 인덱싱된 자료 목록 포함
    if (type === "notebooklm") {
      setNlmPrompt(buildNotebookLmPrompt(genReq, docsByCategory[category] ?? []));
      setResultKind("notebooklm");
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
      setResultKind(type);
    } catch {
      toast.error("생성 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  // 생성물 저장 — 현재 결과(편집 반영분)를 개인 이력에 저장.
  async function handleSave() {
    if (!resultKind) return;
    const payload =
      resultKind === "slides" && deck
        ? { title: deck.title, content: { slides: deck.slides, sources: deck.sources } }
        : nlmPrompt && resultKind === "notebooklm"
          ? {
              title: `${category} ${typeMeta.label}${topic ? ` — ${topic}` : ""}`.slice(0, 200),
              content: { prompt: nlmPrompt },
            }
          : doc
            ? { title: doc.title, content: { sections: doc.sections, sources: doc.sources } }
            : null;
    if (!payload) return;

    setSaving(true);
    try {
      const res = await fetch("/api/generate/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: loadedId ?? undefined,
          kind: resultKind,
          category,
          audience,
          duration,
          topic,
          ...payload,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error("저장 실패", { description: err?.error ?? "잠시 후 다시 시도해 주세요." });
        return;
      }
      // 신규 저장이면 id 를 받아 이후 저장은 같은 행을 수정(중복 저장 방지).
      const json = await res.json().catch(() => null);
      if (json?.id) setLoadedId(json.id);
      setSaved(true);
      toast.success(loadedId ? "수정 저장했습니다" : "저장했습니다", {
        description: "‘저장한 자료’에서 다시 볼 수 있어요.",
      });
    } catch {
      toast.error("저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
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
  // 선택한 분야 색을 페이지 액센트로 흘린다(상단 바·분야 칩·생성 버튼). hex 인라인으로 동적 적용.
  const accent = categoryStyle(category).hex;

  return (
    <div className="space-y-5">
      {/* 입력 폼 — 분야 색이 흐르는 단계형 카드 */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        {/* 분야 색 액센트 바 */}
        <div
          className="h-1 w-full transition-colors duration-500 motion-reduce:transition-none"
          style={{ backgroundColor: accent }}
        />
        <CardContent className="space-y-4 p-4 sm:p-5">
          {/* STEP 01 — 무엇을 만들까요 */}
          <section className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none">
            <StepHeader n="01" title="무엇을 만들까요" />
            {/* 생성 3종 — 인덱싱된 자료로 AI가 파일을 생성(선택 색은 분야 색으로 통일) */}
            <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="생성할 자료">
              {GEN_TYPES.filter((t) => t.key !== "notebooklm").map((t) => {
                const Icon =
                  t.key === "slides"
                    ? Presentation
                    : t.key === "lesson"
                      ? MessageSquareText
                      : FileText;
                const active = type === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setType(t.key)}
                    style={
                      active
                        ? { borderColor: accent, backgroundColor: `${accent}14`, color: accent }
                        : undefined
                    }
                    className={cn(
                      "group flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-xl border p-2.5 text-center transition-all duration-200 motion-reduce:transition-none",
                      "hover:-translate-y-0.5 hover:shadow-sm motion-reduce:hover:translate-y-0",
                      active ? "shadow-sm" : "border-border hover:border-primary/40"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200",
                        !active && "bg-muted text-muted-foreground group-hover:text-primary"
                      )}
                      style={active ? { backgroundColor: accent, color: "#ffffff" } : undefined}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm font-medium">
                      {t.key === "lesson" ? "교안" : t.key === "slides" ? "슬라이드" : t.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* 선택한 유형 설명 — 한 줄 (생성 3종일 때) */}
            {type !== "notebooklm" && (
              <p className="text-sm text-muted-foreground">{typeMeta.description}</p>
            )}

            {/* NotebookLM — 외부 도구용 프롬프트라 동등 카드에서 분리한 보조 액션 */}
            <button
              type="button"
              role="radio"
              aria-checked={type === "notebooklm"}
              onClick={() => setType("notebooklm")}
              style={
                type === "notebooklm"
                  ? { borderColor: accent, backgroundColor: `${accent}14`, color: accent }
                  : undefined
              }
              className={cn(
                "mt-1 flex w-full items-center gap-2.5 rounded-lg border border-dashed p-3 text-left text-sm transition-all duration-200 motion-reduce:transition-none",
                type === "notebooklm"
                  ? "shadow-sm"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
              )}
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                <span className="font-medium">또는 — NotebookLM 프롬프트</span>
                <span className="ml-1.5 text-xs opacity-80">붙여넣어 슬라이드 만들기</span>
              </span>
            </button>
          </section>

          <div className="h-px bg-border/60" />

          {/* STEP 02 — 분야·대상·시간 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="02" title="분야 · 대상 · 시간" />
            {/* 분야 — 선택 시 분야 색으로 강조 */}
            <div className="space-y-2.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                분야
              </Label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="분야">
                {categories.map((c) => {
                  const st = categoryStyle(c);
                  const active = category === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setCategory(c)}
                      style={
                        active
                          ? { borderColor: st.hex, color: st.hex, backgroundColor: `${st.hex}14` }
                          : undefined
                      }
                      className={cn(
                        "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all duration-200 motion-reduce:transition-none",
                        "hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                        active ? "shadow-sm" : "border-border hover:bg-accent/40"
                      )}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: st.hex }} />
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
            <OptionGroup label="대상" options={AUDIENCES} value={audience} onChange={setAudience} />
            <OptionGroup label="교육 시간" options={DURATIONS} value={duration} onChange={setDuration} />
          </section>

          <div className="h-px bg-border/60" />

          {/* STEP 03 — 세부 설정(선택) */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-4 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="03" title="세부 설정" hint="선택" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="topic" className="text-sm font-medium">
                  훈련 내용(주제)
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
                  훈련 일자
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
              <div className="space-y-2.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  AI 모델
                </Label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="AI 모델">
                  {models.map((m) => {
                    const active = model === m.key;
                    return (
                      <button
                        key={m.key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setModel(m.key)}
                        className={cn(
                          "flex h-12 flex-col items-start justify-center rounded-xl border px-4 transition-all duration-200 motion-reduce:transition-none",
                          "hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                          active
                            ? "border-primary bg-primary text-primary-foreground shadow-sm"
                            : "border-border hover:border-primary/40 hover:bg-accent/40"
                        )}
                      >
                        <span className="text-sm font-medium leading-tight">{m.label}</span>
                        {m.note && (
                          <span className="text-[11px] font-normal opacity-70">{m.note}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* 생성 바 — 요약 칩 + 분야 색 CTA */}
          <div className="space-y-3 pt-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">만들 자료</span>
              <Badge variant="secondary" className="font-normal">
                {typeMeta.label}
              </Badge>
              {category && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
                  {category}
                </Badge>
              )}
              <Badge variant="secondary" className="font-normal">
                {audience}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {duration}
              </Badge>
            </div>
            <Button
              className="h-12 w-full gap-2 text-base font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md hover:brightness-105 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
              style={category ? { backgroundColor: accent } : undefined}
              onClick={handleGenerate}
              disabled={loading || !category}
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Wand2 className="h-5 w-5" />
              )}
              {loading ? "생성 중… (수십 초 걸릴 수 있어요)" : `${typeMeta.label} 만들기`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 생성 중 스켈레톤 — 수십 초 대기를 채우는 미리보기 골격 */}
      {loading && (
        <Card className="animate-in fade-in overflow-hidden border-border/60 shadow-sm duration-300">
          <div className="h-1 w-full" style={{ backgroundColor: accent }} />
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="mt-1 h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
            <p className="text-center text-xs text-muted-foreground">
              {typeMeta.label}을(를) 만들고 있어요… 자료를 근거로 구성 중입니다.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 2-a. NotebookLM 프롬프트 결과 */}
      {nlmPrompt && (
        <Card className="animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none">
          <div className="h-1 w-full" style={{ backgroundColor: accent }} />
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
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                className="h-12 flex-1 gap-2 text-base"
                onClick={() => handleCopy(nlmPrompt)}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                프롬프트 복사
              </Button>
              <Button
                variant="outline"
                className="h-12 flex-1 gap-2 text-base"
                disabled={saving || saved}
                onClick={handleSave}
              >
                {saved ? (
                  <Check className="h-4 w-4" />
                ) : saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saved ? "저장됨" : loadedId ? "수정 저장" : "저장"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2-b. 슬라이드 결과 — 표준 양식(분야 색) PPTX로 변환 */}
      {deck && (
        <Card
          className={cn(
            "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
            editing && "ring-1 ring-primary/40"
          )}
        >
          <div className="h-1 w-full" style={{ backgroundColor: accent }} />
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              {editing ? (
                <Input
                  value={deck.title}
                  onChange={(e) =>
                    setDeck((prev) => (prev ? { ...prev, title: e.target.value } : prev))
                  }
                  className="h-9 text-base font-semibold"
                  aria-label="발표 제목"
                />
              ) : (
                <CardTitle className="flex items-center gap-2 text-base">
                  <Presentation className="h-4 w-4" style={{ color: accent }} /> {deck.title}
                </CardTitle>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={saving || saved}
                  onClick={handleSave}
                >
                  {saved ? (
                    <Check className="h-4 w-4" />
                  ) : saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saved ? "저장됨" : loadedId ? "수정 저장" : "저장"}
                </Button>
                <Button
                  variant={editing ? "default" : "outline"}
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setEditing((v) => !v)}
                >
                  {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                  {editing ? "완료" : "편집"}
                </Button>
              </div>
            </div>
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
                  {editing ? (
                    <div className="space-y-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs text-muted-foreground">{i + 1}</span>
                        <Input
                          value={s.title}
                          onChange={(e) => patchSlide(i, { title: e.target.value })}
                          className="h-9 font-semibold"
                          aria-label={`슬라이드 ${i + 1} 제목`}
                        />
                      </div>
                      <div className="space-y-1 pl-5">
                        {s.bullets.map((b, j) => (
                          <Input
                            key={j}
                            value={b}
                            onChange={(e) => patchBullet(i, j, e.target.value)}
                            className="h-9 text-sm"
                            aria-label={`슬라이드 ${i + 1} 항목 ${j + 1}`}
                          />
                        ))}
                      </div>
                      <Textarea
                        value={s.notes}
                        onChange={(e) => patchSlide(i, { notes: e.target.value })}
                        className="min-h-[60px] text-xs"
                        aria-label={`슬라이드 ${i + 1} 발표자 노트`}
                        placeholder="발표자 노트"
                      />
                      {renderRegen("slide", i)}
                    </div>
                  ) : (
                    <>
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
                    </>
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
        <Card
          className={cn(
            "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
            editing && "ring-1 ring-primary/40"
          )}
        >
          <div className="h-1 w-full" style={{ backgroundColor: accent }} />
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              {editing ? (
                <Input
                  value={doc.title}
                  onChange={(e) =>
                    setDoc((prev) => (prev ? { ...prev, title: e.target.value } : prev))
                  }
                  className="h-9 text-base font-semibold"
                  aria-label="문서 제목"
                />
              ) : (
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" style={{ color: accent }} /> {doc.title}
                </CardTitle>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={saving || saved}
                  onClick={handleSave}
                >
                  {saved ? (
                    <Check className="h-4 w-4" />
                  ) : saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saved ? "저장됨" : loadedId ? "수정 저장" : "저장"}
                </Button>
                <Button
                  variant={editing ? "default" : "outline"}
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setEditing((v) => !v)}
                >
                  {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                  {editing ? "완료" : "편집"}
                </Button>
              </div>
            </div>
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
              <section key={i} className="space-y-1">
                {editing ? (
                  <>
                    <Input
                      value={s.heading}
                      onChange={(e) => patchSection(i, { heading: e.target.value })}
                      className="h-9 font-semibold"
                      aria-label={`섹션 ${i + 1} 제목`}
                    />
                    <Textarea
                      value={s.content}
                      onChange={(e) => patchSection(i, { content: e.target.value })}
                      className="min-h-[120px] text-sm leading-relaxed"
                      aria-label={`섹션 ${i + 1} 본문`}
                    />
                    {renderRegen("section", i)}
                  </>
                ) : (
                  <>
                    <h3 className="mb-1 font-semibold">{s.heading}</h3>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {s.content}
                    </p>
                  </>
                )}
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
