"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  ShieldAlert,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  DURATIONS,
  GEN_TYPES,
  blockingGenerationQualityIssues,
  inspectCurrentGenerationQuality,
  type Duration,
  type GeneratedDoc,
  type GenerationQualityIssue,
  type GenerationQualityReport,
  type SavedMaterial,
} from "@/lib/generate";
import { hydrateMaterial } from "@/lib/generate-material";
import { prepareGeneratedDocForExport } from "@/lib/document-export";
import {
  inspectSopContract,
  type SopContractReport,
} from "@/lib/sop-evidence";
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

type DocContent = {
  sections?: GeneratedDoc["sections"];
  sources?: GeneratedDoc["sources"];
  date?: unknown;
  place?: unknown;
};
type NlmContent = { prompt?: string };

/** 저장한 훈련계획도 생성 직후와 같은 전북소방 표준 HWPX 메타데이터를 사용한다. */
export function savedMaterialHwpxOptions(material: SavedMaterial):
  | {
      template: "training_plan";
      plan: {
        topic: string;
        datetime: string;
        formType: string;
        method: string;
        duration?: string;
        target?: string;
        place: string;
      };
    }
  | undefined {
  if (material.kind !== "plan") return undefined;
  const content = material.content as DocContent;
  return {
    template: "training_plan",
    plan: {
      topic: material.topic?.trim() || `${material.category ?? "구조"} 훈련`,
      datetime: typeof content.date === "string" ? content.date : "",
      formType: "이론 + 현장실습",
      method: "자체훈련",
      duration: material.duration ?? undefined,
      target: material.audience ?? undefined,
      place: typeof content.place === "string" ? content.place : "",
    },
  };
}

const MISSING_SAVED_SOP_REPORT: SopContractReport = {
  ok: false,
  issues: [
    {
      code: "missing_sop_disclosure",
      path: "content.sopEvidence",
      message: "저장본에 검증된 SOP 근거 상태가 없습니다.",
    },
  ],
};

const MISSING_SAVED_RESULT_REPORT: GenerationQualityReport = {
  ok: false,
  issues: [
    {
      code: "missing_section",
      path: "content",
      message: "저장된 결과 본문을 불러올 수 없습니다.",
    },
  ],
};

const MISSING_SAVED_DURATION_ISSUE: GenerationQualityIssue = {
  code: "missing_time_allocation",
  path: "duration",
  message: "교육 시간이 없는 이전 자료라 시간 배분을 확인할 수 없습니다.",
};

/** 저장 목록의 내보내기·공유·복제 전에 과거 저장본까지 같은 SOP 계약으로 검사한다. */
export function inspectSavedMaterialSop(material: SavedMaterial): SopContractReport {
  if (material.kind === "notebooklm") return { ok: true, issues: [] };

  const hydrated = hydrateMaterial(material);
  const result = material.kind === "slides" ? hydrated.deck : hydrated.doc;
  const evidence = result?.sopEvidence;
  if (!result || !evidence) return MISSING_SAVED_SOP_REPORT;

  return inspectSopContract(material.kind, result, evidence);
}

/**
 * 저장본도 생성 직후 화면과 같은 중앙 품질검사를 통과해야 공식 파일·복사·공유에 쓸 수 있다.
 * 과거 저장본의 누락된 시간·SOP 상태만 저장 형식 경계에서 보완해 검사한다.
 */
export function inspectSavedMaterialQuality(
  material: SavedMaterial
): GenerationQualityReport {
  if (material.kind === "notebooklm") return { ok: true, issues: [] };

  const hydrated = hydrateMaterial(material);
  const result = material.kind === "slides" ? hydrated.deck : hydrated.doc;
  if (!result) return MISSING_SAVED_RESULT_REPORT;

  const duration = DURATIONS.includes(material.duration as Duration)
    ? (material.duration as Duration)
    : null;
  const checked = inspectCurrentGenerationQuality(
    material.kind,
    result,
    duration ?? "2시간"
  );
  const extraIssues: GenerationQualityIssue[] = [];
  if (!duration) extraIssues.push(MISSING_SAVED_DURATION_ISSUE);
  if (!result.sopEvidence) extraIssues.push(...MISSING_SAVED_SOP_REPORT.issues);

  const issues = [...checked.issues, ...extraIssues];
  return { ok: issues.length === 0, issues };
}

/** 저장 목록에서 실제 내보내기·복사·공유를 막는 핵심 오류만 반환한다. */
export function savedMaterialBlockingQualityIssues(
  material: SavedMaterial
): GenerationQualityIssue[] {
  return blockingGenerationQualityIssues(inspectSavedMaterialQuality(material));
}

/** 검색장애 상태는 개인 보관할 수 있지만 내보내기·공유 전에 현재 근거 확인이 필요하다. */
export function savedMaterialSopStatus(
  material: SavedMaterial
): "found" | "not_found" | "degraded" | undefined {
  if (material.kind === "notebooklm") return undefined;
  const hydrated = hydrateMaterial(material);
  return (material.kind === "slides" ? hydrated.deck : hydrated.doc)?.sopEvidence?.status;
}

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
  const busyRef = useRef(false);

  // 충돌 뒤 router.refresh()로 받은 최신 서버 목록을 로컬 상태에도 반영한다.
  useEffect(() => {
    setItems(initial);
    setOpenId((current) =>
      current !== null && initial.some((item) => item.id === current) ? current : null
    );
  }, [initial]);

  // 목록이 다시 그려질 때마다 여러 차례 전체 품질검사를 반복하지 않는다.
  const diagnostics = useMemo(
    () =>
      new Map(
        items.map((item) => {
          const blockingIssues = savedMaterialBlockingQualityIssues(item);
          return [
            item.id,
            {
              blockingIssues,
              sopStatus: savedMaterialSopStatus(item),
            },
          ] as const;
        })
      ),
    [items]
  );

  function ensureQualityReady(it: SavedMaterial, action: string): boolean {
    const blockingIssues = savedMaterialBlockingQualityIssues(it);
    if (blockingIssues.length === 0) return true;

    const detail = blockingIssues
      .slice(0, 2)
      .map((issue) => issue.message)
      .join(" · ");
    const remaining =
      blockingIssues.length > 2
        ? ` · 그 밖의 핵심 오류 ${blockingIssues.length - 2}개`
        : "";
    toast.error(`${action} 전 핵심 품질을 보완해 주세요`, {
      description: `${detail}${remaining} ${
        mode === "own"
          ? "편집에서 다시 생성하거나 내용을 수정해 주세요."
          : "작성자가 품질을 보완해 다시 공유해야 합니다."
      }`,
    });
    return false;
  }

  async function handleDownload(it: SavedMaterial) {
    if (busyRef.current) return;
    if (!ensureQualityReady(it, it.kind === "notebooklm" ? "복사" : "내보내기")) {
      return;
    }
    busyRef.current = true;
    setBusyId(it.id);
    let visualToastId: string | number | undefined;
    try {
      if (it.kind !== "notebooklm") {
        let response: Response;
        try {
          response = await fetch("/api/generate/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(110_000),
            body: JSON.stringify({
              kind: it.kind, title: it.title, category: it.category,
              topic: it.topic, audience: it.audience ?? undefined,
              duration: it.duration ?? undefined, content: it.content,
            }),
          });
        } catch {
          throw new Error("원문 근거 확인에 연결하지 못해 다운로드를 보류했습니다. 잠시 후 다시 시도해 주세요.");
        }
        const payload = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; degraded?: unknown } | null;
        if (!response.ok || payload?.ok !== true || payload.degraded === true) {
          throw new Error(typeof payload?.error === "string"
            ? payload.error
            : "현재 원문 근거를 확인하지 못해 다운로드를 보류했습니다. 잠시 후 다시 시도해 주세요.");
        }
      }
      if (it.kind === "slides") {
        const deck = hydrateMaterial(it).deck;
        if (!deck) throw new Error("저장한 슬라이드를 불러오지 못했습니다.");
        visualToastId = toast.loading("원문 시각자료를 준비하고 있습니다…");
        const [{ downloadPptx }, { prepareDeckSourceVisuals }] = await Promise.all([
          import("@/lib/pptx"),
          import("@/lib/source-visuals"),
        ]);
        // 저장된 원문·도형·내용 선택을 그대로 내보내고 런타임 이미지만 준비한다.
        const prepared = await prepareDeckSourceVisuals(deck);
        if (prepared.requested === 0) {
          toast.dismiss(visualToastId);
          visualToastId = undefined;
        } else if (prepared.failed > 0) {
          const textOnlyCount = prepared.fallbacks.filter(
            (fallback) => fallback.reason === "text-only-page"
          ).length;
          toast.warning("일부 원문 이미지는 도형·내용 구도로 대신했습니다", {
            id: visualToastId,
            description: `${prepared.resolved}개 반영 · ${prepared.failed}개 대체${
              textOnlyCount > 0 ? ` · 텍스트 위주 페이지 ${textOnlyCount}개 제외` : ""
            }`,
          });
          visualToastId = undefined;
        } else {
          toast.success("원문 시각자료를 반영했습니다", {
            id: visualToastId,
            description: `${prepared.resolved}개 페이지를 슬라이드에 넣었습니다.`,
          });
          visualToastId = undefined;
        }
        await downloadPptx(
          prepared.deck,
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
        if ((await downloadHwpx(doc, savedMaterialHwpxOptions(it))) === "local") {
          toast.info("한글 작성 서버 미연결 — 기본 양식으로 생성했습니다");
        }
      }
    } catch (error) {
      if (visualToastId !== undefined) toast.dismiss(visualToastId);
      toast.error("다운로드에 실패했습니다", {
        description: error instanceof Error ? error.message : "잠시 후 다시 시도해 주세요.",
      });
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  async function handleDelete(it: SavedMaterial) {
    if (busyRef.current) return;
    if (!window.confirm("이 자료를 삭제할까요? 되돌릴 수 없습니다.")) return;
    busyRef.current = true;
    setBusyId(it.id);
    try {
      const params = new URLSearchParams({
        id: String(it.id),
        revision: String(it.revision),
      });
      const res = await fetch(`/api/generate/save?${params}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(
          typeof payload?.error === "string" ? payload.error : "삭제에 실패했습니다"
        );
        if (res.status === 409) router.refresh();
        return;
      }
      setItems((prev) => prev.filter((item) => item.id !== it.id));
      if (openId === it.id) setOpenId(null);
      toast.success("삭제했습니다");
    } catch {
      toast.error("삭제 중 오류가 발생했습니다");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  // 내 자료 공유/해제 토글
  async function toggleShare(it: SavedMaterial) {
    if (busyRef.current) return;
    const next = !it.shared;
    // 오래된 비준수 자료도 공유 해제는 즉시 가능해야 한다.
    if (next && !ensureQualityReady(it, "공유")) return;
    if (next && savedMaterialSopStatus(it) === "degraded") {
      toast.error("SOP 검색 상태를 다시 확인한 뒤 공유해 주세요", {
        description:
          "검색장애 상태의 자료는 개인 보관할 수 있습니다. 검색이 정상화되면 다시 생성·저장해 주세요.",
      });
      return;
    }
    busyRef.current = true;
    setBusyId(it.id);
    try {
      const res = await fetch("/api/generate/save", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, shared: next }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(
          typeof payload?.error === "string" ? payload.error : "공유 설정을 변경하지 못했습니다."
        );
        return;
      }
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, shared: next } : x)));
      toast.success(next ? "공유했습니다. 동료가 볼 수 있어요." : "공유를 해제했습니다.");
    } catch {
      toast.error("네트워크 오류로 변경하지 못했습니다.");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  // 공유 자료를 내 자료로 복제(편집 가능하게)
  async function cloneToMine(it: SavedMaterial) {
    if (busyRef.current) return;
    if (!ensureQualityReady(it, "복제")) return;
    busyRef.current = true;
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
        const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
        toast.error(typeof payload?.error === "string" ? payload.error : "복제에 실패했습니다");
        return;
      }
      toast.success("내 자료로 복제했습니다. ‘저장한 자료’에서 편집할 수 있어요.");
    } catch {
      toast.error("네트워크 오류로 복제하지 못했습니다");
    } finally {
      busyRef.current = false;
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
        const diagnostic = diagnostics.get(it.id);
        const blockingIssues = diagnostic?.blockingIssues ?? [];
        const qualityReady = blockingIssues.length === 0;
        const sopSearchUnavailable = diagnostic?.sopStatus === "degraded";
        const hydratedPreview = open && it.kind !== "notebooklm" ? hydrateMaterial(it) : null;
        const previewDoc = hydratedPreview?.doc
          ? prepareGeneratedDocForExport(hydratedPreview.doc)
          : null;
        const previewDeck = hydratedPreview?.deck;
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
                    {!qualityReady && it.kind !== "notebooklm" && (
                      <Badge
                        variant="secondary"
                        className="gap-1 font-normal text-destructive"
                        title="핵심 품질 오류를 보완한 뒤 내보내거나 공유할 수 있습니다."
                      >
                        <ShieldAlert className="h-3 w-3" /> 품질 보완 필요
                      </Badge>
                    )}
                    {qualityReady && sopSearchUnavailable && (
                      <Badge
                        variant="secondary"
                        className="gap-1 font-normal text-amber-700 dark:text-amber-300"
                        title="SOP 검색이 정상화된 뒤 다시 생성·저장해야 공유할 수 있습니다."
                      >
                        <ShieldAlert className="h-3 w-3" /> SOP 검색 재확인 필요
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {!qualityReady && it.kind !== "notebooklm" && (
                <div
                  role="alert"
                  className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm"
                >
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="font-medium text-destructive">
                      내보내기·복사·공유 전에 품질 보완이 필요합니다.
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {blockingIssues
                        .slice(0, 2)
                        .map((issue) => issue.message)
                        .join(" · ")}
                      {blockingIssues.length > 2
                        ? ` · 그 밖의 핵심 오류 ${blockingIssues.length - 2}개`
                        : ""}
                      {mode === "own"
                        ? " 편집에서 다시 생성하거나 내용을 수정해 주세요."
                        : " 작성자가 보완해 다시 공유해야 합니다."}
                    </p>
                  </div>
                </div>
              )}

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
                  disabled={busyId !== null}
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
                    disabled={busyId !== null}
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
                    disabled={busyId !== null}
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
                      disabled={busyId !== null}
                      onClick={() => toggleShare(it)}
                      title={
                        !it.shared && sopSearchUnavailable
                          ? "SOP 검색이 정상화된 뒤 다시 생성·저장해야 공유할 수 있습니다."
                          : undefined
                      }
                    >
                      <Share2 className="h-4 w-4" /> {it.shared ? "공유 해제" : "공유"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto gap-1.5 text-destructive hover:text-destructive"
                      disabled={busyId !== null}
                      onClick={() => handleDelete(it)}
                    >
                      <Trash2 className="h-4 w-4" /> 삭제
                    </Button>
                  </>
                )}
              </div>

              {open && (
                <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t pt-3 text-sm duration-200">
                  {it.kind === "slides" ? (
                    (previewDeck?.slides ?? []).map((s, i) => (
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
                    <>
                      {(previewDoc?.sections ?? []).map((s, i) => (
                        <section key={i}>
                          <h3 className="font-semibold">{s.heading}</h3>
                          <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                            {s.content}
                          </p>
                        </section>
                      ))}
                      {previewDoc && previewDoc.sources.length > 0 && (
                        <section className="rounded-lg border border-border/60 bg-muted/30 p-3">
                          <h3 className="font-semibold">근거 자료 및 출처</h3>
                          <ul className="mt-1 space-y-0.5 text-muted-foreground">
                            {previewDoc.sources.map((source) => (
                              <li key={`${source.document_id}:${source.page ?? "-"}`}>
                                {source.doc}
                                {source.page != null ? ` p.${source.page}` : ""}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </>
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
