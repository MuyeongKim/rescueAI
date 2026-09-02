import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationWaitStatus, ResultSkeleton } from "@/components/generate/parts";

describe("영속 생성 연결 안내", () => {
  it("Workflow 연결 전에는 화면을 유지하라고 안내한다", () => {
    const html = renderToStaticMarkup(
      <GenerationWaitStatus
        estimatedSeconds={720}
        fixedStage="정밀 생성 작업을 준비하는 중"
        progress={0}
        dispatchPending
      />
    );

    expect(html).toContain("연결 완료 안내가 보일 때까지 이 화면을 유지");
    expect(html).not.toContain("화면을 닫아도 계속 진행");
  });

  it("Workflow 연결 후에만 화면을 닫아도 된다고 안내한다", () => {
    const html = renderToStaticMarkup(
      <GenerationWaitStatus
        estimatedSeconds={720}
        fixedStage="관련 교범과 SOP를 선별하는 중"
        progress={5}
        persistent
      />
    );

    expect(html).toContain("화면을 닫아도 계속 진행");
    expect(html).not.toContain("연결 완료 안내가 보일 때까지 이 화면을 유지");
  });

  it("응답 유실 여부를 확인하는 동안 실패 화면 대신 접수 확인 상태를 보여준다", () => {
    const html = renderToStaticMarkup(
      <ResultSkeleton
        accent="#ef4444"
        label="슬라이드"
        type="slides"
        duration="1시간"
        verifyingDelivery
      />
    );

    expect(html).toContain("서버 접수 상태를 확인하는 중");
    expect(html).toContain("작업 번호를 보존했고");
    expect(html).not.toContain("자료 생성을 완료하지 못했습니다");
  });
});
