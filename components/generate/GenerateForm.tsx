"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
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
  type GeneratedSection,
  type GeneratedSlide,
  type GeneratedSlideDeck,
  type SavedMaterial,
} from "@/lib/generate";
import { asAudience, asDuration, hydrateMaterial } from "@/lib/generate-material";
import { categoryStyle } from "@/lib/category";
import { cn, sanitizeFilename } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  OptionGroup,
  ResultSkeleton,
  StepHeader,
  type GenerationQuality,
  type RegenState,
  type ResultChrome,
} from "@/components/generate/parts";
import { DocResult } from "@/components/generate/DocResult";
import { NotebookLmResult } from "@/components/generate/NotebookLmResult";
import { SlideDeckResult } from "@/components/generate/SlideDeckResult";

const TOPIC_SUGGESTIONS: Record<string, readonly string[]> = {
  화재: ["공기호흡기 점검과 착용", "고립소방관 구조 절차", "화재현장 인명검색 안전수칙"],
  수난: ["급류구조 안전수칙", "잠수구조 사전 점검", "구명보트 운용과 전복 대응"],
  산악: ["로프 하강과 확보", "들것 결착과 환자 운반", "산악구조 안전관리"],
  일반구조: ["교통사고 구조장비 운용", "문 개방 구조 절차", "중량물 인양 안전수칙"],
  "현장지휘·공통": ["구조현장 지휘체계", "대원 안전관리와 위험성 평가", "현장 통신과 상황보고"],
  화학사고: ["화학사고 초동대응", "보호복 착용과 오염통제", "누출물질 확인과 안전구역 설정"],
};

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
  const [topicError, setTopicError] = useState(false);
  const [date, setDate] = useState("");
  // 훈련계획 양식(training_plan.hwpx) 전용 폼 입력
  const [place, setPlace] = useState("");
  const [trainingType, setTrainingType] = useState<string>("이론 + 현장실습");
  const [method, setMethod] = useState<string>("자체훈련");
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
  const [quality, setQuality] = useState<GenerationQuality | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(initialMaterial?.id ?? null); // 재편집 대상 id

  const genReq = { type, category, audience, duration, topic: topic.trim(), date, place, model };
  const subtitle = `대상: ${audience} · 교육 시간: ${duration}${date ? ` · ${date}` : ""}`;
  const connectedDocs = docsByCategory[category]?.length ?? 0;
  const suggestions =
    TOPIC_SUGGESTIONS[category] ??
    ([`${category} 핵심 절차`, `${category} 장비 점검`, `${category} 안전수칙`] as const);

  // 결과 부분 편집 — 편집 내용은 그대로 다운로드/복사에 반영된다(빌더가 state를 받음).
  function patchSection(i: number, patch: Partial<GeneratedSection>) {
    setSaved(false);
    setQuality(null);
    setDoc((prev) =>
      prev
        ? { ...prev, sections: prev.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : prev
    );
  }
  function patchSlide(i: number, patch: Partial<GeneratedSlide>) {
    setSaved(false);
    setQuality(null);
    setDeck((prev) =>
      prev
        ? { ...prev, slides: prev.slides.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : prev
    );
  }
  function patchBullet(slideI: number, bulletI: number, value: string) {
    setSaved(false);
    setQuality(null);
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
      const retrievalDegraded = res.headers.get("X-RAG-Degraded") === "1";
      if (kind === "section") patchSection(index, json as GeneratedSection);
      else patchSlide(index, json as GeneratedSlide);
      toast.success("다시 생성했습니다", {
        description: retrievalDegraded
          ? "자료 검색 일부 기능이 제한되어 회수 근거를 한 번 더 확인해 주세요."
          : undefined,
      });
      setRegenIdx(null);
      setRegenText("");
    } catch {
      toast.error("재생성 중 오류가 발생했습니다.");
    } finally {
      setRegenLoading(null);
    }
  }

  async function handleGenerate() {
    const trimmedTopic = topic.trim();
    if (trimmedTopic.length < 2) {
      setTopicError(true);
      document.getElementById("topic")?.focus();
      toast.error("훈련 주제를 입력해 주세요", {
        description: "구체적인 주제가 있어야 관련 교범을 정확히 찾아 좋은 자료를 만들 수 있습니다.",
      });
      return;
    }

    setTopicError(false);
    setCopied(false);
    setEditing(false);
    setRegenIdx(null);
    setSaved(false);
    setQuality(null);
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
      const json = (await res.json()) as Record<string, unknown> & {
        quality?: GenerationQuality;
      };
      setQuality(json.quality ?? null);
      if (type === "slides") setDeck(json as unknown as GeneratedSlideDeck);
      else setDoc(json as unknown as GeneratedDoc);
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
      downloadBlob(await buildDocxBlob(doc), `${sanitizeFilename(doc.title)}.docx`);
    } catch {
      toast.error("문서 파일 생성에 실패했습니다");
    }
  }

  async function handleHwpx() {
    if (!doc) return;
    try {
      // 미니서버(hwp-writer-api) 우선, 실패 시 로컬 생성 폴백.
      // 훈련계획(plan)은 전북소방 표준 양식(training_plan.hwpx)에 폼 입력 + AI 섹션을 채운다.
      const { downloadHwpx } = await import("@/lib/hwpx-download");
      const opts =
        resultKind === "plan"
          ? {
              template: "training_plan" as const,
              plan: {
                topic: topic || `${category} 훈련`,
                datetime: date,
                formType: trainingType,
                method,
                duration,
                target: audience,
                place,
              },
            }
          : undefined;
      const via = await downloadHwpx(doc, opts);
      if (via === "local") {
        toast.info("한글 작성 서버 미연결 — 기본 양식으로 생성했습니다");
      }
    } catch (error) {
      toast.error("한글 파일 생성에 실패했습니다", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  const typeMeta = GEN_TYPES.find((t) => t.key === type)!;
  // 선택한 분야 색을 페이지 액센트로 흘린다(상단 바·분야 칩·생성 버튼). hex 인라인으로 동적 적용.
  const accent = categoryStyle(category).hex;

  // 결과 카드 3종이 공유하는 상단 컨트롤(저장·편집)과 항목별 재생성 상태.
  const chrome: ResultChrome = {
    accent,
    editing,
    onToggleEdit: () => setEditing((v) => !v),
    saving,
    saved,
    loadedId,
    onSave: handleSave,
  };
  // 재생성 대상(섹션/슬라이드)은 결과 종류마다 다르므로 kind 를 명시해 각각 만든다.
  const makeRegen = (kind: "section" | "slide"): RegenState => ({
    openIndex: regenIdx,
    loadingIndex: regenLoading,
    text: regenText,
    onTextChange: setRegenText,
    onOpen: (index) => {
      setRegenIdx(index);
      setRegenText("");
    },
    onClose: () => setRegenIdx(null),
    onApply: (index, instruction) => handleRegen(kind, index, instruction),
  });

  return (
    <div className="space-y-5">
      {/* 입력 폼 — 분야 색이 흐르는 단계형 카드 */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        {/* 분야 색 액센트 바 */}
        <div
          className="h-1 w-full transition-colors duration-500 motion-reduce:transition-none"
          style={{ backgroundColor: accent }}
        />
        <CardContent className="space-y-3 p-4 sm:p-5">
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
                      "group flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-md border p-2.5 text-center transition-all duration-200 motion-reduce:transition-none",
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
                "mt-1 flex min-h-12 w-full items-center gap-2.5 rounded-md border border-dashed p-3 text-left text-sm transition-all duration-200 motion-reduce:transition-none",
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
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="02" title="분야 · 대상 · 시간" />
            {/* 분야 — 선택 시 분야 색으로 강조 */}
            <div className="space-y-2.5">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
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
                        "inline-flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all duration-200 motion-reduce:transition-none md:h-10",
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

          {/* STEP 03 — 검색 품질을 좌우하는 주제와 세부 설정 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="03" title="무엇을 훈련할까요" hint="주제는 필수예요" />
            <div
              className="border-l-4 bg-muted/45 px-3 py-2.5"
              style={{ borderLeftColor: accent }}
            >
              <p className="text-sm font-medium">
                주제가 구체적일수록 교범의 정확한 절차를 찾습니다.
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                현재 {category} 분야 자료 {connectedDocs}개 연결 · 목표, 절차, 장비, 안전사항을 함께
                점검해 구성합니다.
              </p>
              {connectedDocs === 1 && (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  연결 자료가 1개라 해당 교범 범위 안에서만 작성됩니다.
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="topic" className="text-sm font-medium">
                  훈련 내용(주제) <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="topic"
                  placeholder="예: 공기호흡기 점검 절차"
                  value={topic}
                  onChange={(e) => {
                    setTopic(e.target.value);
                    if (e.target.value.trim().length >= 2) setTopicError(false);
                  }}
                  maxLength={100}
                  aria-invalid={topicError}
                  aria-describedby="topic-help"
                  className={cn("h-12 text-base md:h-10", topicError && "border-destructive")}
                />
                <p
                  id="topic-help"
                  className={cn(
                    "text-xs leading-relaxed",
                    topicError ? "font-medium text-destructive" : "text-muted-foreground"
                  )}
                >
                  {topicError
                    ? "훈련 주제를 두 글자 이상 입력해 주세요."
                    : "한 문장만 적으면 관련 자료를 찾아 교육 흐름까지 구성합니다."}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1" aria-label="추천 훈련 주제">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => {
                        setTopic(suggestion);
                        setTopicError(false);
                      }}
                      className="min-h-9 rounded-full border border-border bg-background px-3 text-left text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="date" className="text-sm font-medium">
                  훈련 일자
                </Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-12 text-base md:h-10"
                />
              </div>
              {/* 훈련계획 양식 전용 — 훈련 장소 */}
              {type === "plan" && (
                <div className="space-y-1.5">
                  <Label htmlFor="place" className="text-sm font-medium">
                    훈련 장소
                  </Label>
                  <Input
                    id="place"
                    placeholder="예: 소방교육훈련센터 훈련탑"
                    value={place}
                    onChange={(e) => setPlace(e.target.value)}
                    maxLength={100}
                    className="h-12 text-base md:h-10"
                  />
                </div>
              )}
            </div>

            {/* 훈련계획 양식 전용 — 훈련 형태·방법(한글 다운로드 시 양식에 반영) */}
            {type === "plan" && (
              <div className="space-y-3">
                <OptionGroup
                  label="훈련 형태"
                  options={["현장실습 훈련", "이론 교육훈련", "이론 + 현장실습"]}
                  value={trainingType}
                  onChange={setTrainingType}
                />
                <OptionGroup
                  label="훈련 방법"
                  options={["합동훈련", "자체훈련", "구조대장 기술지원"]}
                  value={method}
                  onChange={setMethod}
                />
              </div>
            )}

            {/* 응답 방식 선택 — 2개 이상 사용 가능할 때만. NotebookLM은 AI를 안 쓰므로 숨김 */}
            {type !== "notebooklm" && models.length > 1 && (
              <div className="space-y-2.5">
                <Label className="text-xs font-semibold uppercase text-muted-foreground">
                  응답 방식
                </Label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="응답 방식">
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
                          "flex h-12 flex-col items-start justify-center rounded-md border px-4 transition-all duration-200 motion-reduce:transition-none md:h-11",
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
          <div className="space-y-2">
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
              {topic.trim() && (
                <Badge variant="secondary" className="max-w-full font-normal">
                  <span className="truncate">{topic.trim()}</span>
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
              {loading ? "자료를 찾고 초안을 점검하는 중…" : `${typeMeta.label} 만들기`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && <ResultSkeleton accent={accent} label={typeMeta.label} />}

      {/* 2-a. NotebookLM 프롬프트 결과 */}
      {nlmPrompt && (
        <NotebookLmResult
          prompt={nlmPrompt}
          chrome={chrome}
          copied={copied}
          onCopy={handleCopy}
        />
      )}

      {/* 2-b. 슬라이드 결과 — 표준 양식(분야 색) PPTX로 변환 */}
      {deck && (
        <SlideDeckResult
          deck={deck}
          chrome={chrome}
          regen={makeRegen("slide")}
          quality={quality}
          onTitleChange={(title) => {
            setSaved(false);
            setQuality(null);
            setDeck((prev) => (prev ? { ...prev, title } : prev));
          }}
          onPatchSlide={patchSlide}
          onPatchBullet={patchBullet}
          onDownloadPptx={handlePptx}
        />
      )}

      {/* 2-c. 생성 문서 결과 */}
      {doc && (
        <DocResult
          doc={doc}
          chrome={chrome}
          regen={makeRegen("section")}
          copied={copied}
          quality={quality}
          onTitleChange={(title) => {
            setSaved(false);
            setQuality(null);
            setDoc((prev) => (prev ? { ...prev, title } : prev));
          }}
          onPatchSection={patchSection}
          onDownloadHwpx={handleHwpx}
          onDownloadDocx={handleDocx}
          onCopy={handleCopy}
        />
      )}
    </div>
  );
}
