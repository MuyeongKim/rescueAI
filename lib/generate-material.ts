// 생성물 ↔ 폼 상태 변환 (순수 함수, 클라이언트/서버 공용).
// UI(components/generate/*)에서 분리해 두면 저장본 복원 규칙을 테스트로 고정할 수 있다.
import {
  AUDIENCES,
  DURATIONS,
  type Audience,
  type Duration,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type SavedMaterial,
} from "@/lib/generate";

export const DEFAULT_AUDIENCE: Audience = "일반 대원";
export const DEFAULT_DURATION: Duration = "2시간";

export const asAudience = (v?: string | null): Audience =>
  AUDIENCES.includes(v as Audience) ? (v as Audience) : DEFAULT_AUDIENCE;

export const asDuration = (v?: string | null): Duration =>
  DURATIONS.includes(v as Duration) ? (v as Duration) : DEFAULT_DURATION;

export type HydratedMaterial = {
  doc: GeneratedDoc | null;
  deck: GeneratedSlideDeck | null;
  nlm: string | null;
};

/** 저장본(SavedMaterial)을 폼 결과 상태로 복원한다(재편집 진입). */
export function hydrateMaterial(m?: SavedMaterial | null): HydratedMaterial {
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
  if (m.kind === "notebooklm") {
    return { doc: null, deck: null, nlm: c.prompt ?? "" };
  }
  return {
    doc: { title: m.title, sections: c.sections ?? [], sources: c.sources ?? [] },
    deck: null,
    nlm: null,
  };
}

/** 생성 문서를 클립보드 복사용 평문으로 편다(제목 + 섹션 + 근거 목록). */
export function docToText(doc: GeneratedDoc): string {
  const body = doc.sections.map((s) => `${s.heading}\n${s.content}`).join("\n\n");
  const sources = doc.sources.length
    ? `\n\n[근거 자료]\n${doc.sources
        .map((s) => `- ${s.doc}${s.page != null ? ` p.${s.page}` : ""}`)
        .join("\n")}`
    : "";
  return `${doc.title}\n\n${body}${sources}`;
}
