import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "ai";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/chat/MessageBubble";
import {
  CHAT_SOURCE_SECTION_TITLE,
  prepareChatAnswerText,
  uniqueChatSources,
} from "@/lib/chat-answer";
import type { DocSource } from "@/lib/database.types";
import { demoChatAnswer } from "@/lib/demo";

const sources: DocSource[] = [
  { document_id: 7, doc: "화학보호복 교범", page: 3, content: "착용 전 점검" },
  { document_id: 7, doc: "화학보호복  교범", page: 3, content: "중복 청크" },
  { document_id: 7, doc: "화학보호복 교범", page: 4, content: "탈의 절차" },
];

describe("AI 튜터 답변 출처 정리", () => {
  it("실제 답변 형식의 제목·강조·목록·표를 의미 있는 HTML로 렌더한다", () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: {
      id: "markdown", role: "assistant",
      content: "**핵심 답변**\n\n### 1. 준비·사전점검\n* **준비 장비 확인:** 장비를 확인합니다.\n\n| 항목 | 확인 |\n| --- | --- |\n| 외관 | 손상 없음 |",
    } }));
    expect(html).toContain("<strong");
    expect(html).toContain("<h3");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<table");
    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("**핵심 답변**");
    expect(html).not.toContain("### 1.");
  });

  it("HTML·위험 URL·외부 이미지로 코드 실행이나 자동 요청을 만들지 않는다", () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: {
      id: "unsafe-markdown", role: "assistant",
      content: '<script>alert(1)</script>\n\n[링크](javascript:alert%281%29)\n\n![추적 이미지](https://example.com/track.png)\n\n<img src=x onerror=alert(1)>',
    } }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/track.png");
    expect(html).toContain("이미지 설명: 추적 이미지");
  });

  it("재열람된 검색 장애와 답변 저장 실패를 숨기지 않는다", () => {
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: {
      id: "warning", role: "assistant", content: "일부 근거로 답변합니다.",
      annotations: [{ messageId: null, degraded: true, saveFailed: true }],
    } }));
    expect(html).toContain("자료 검색이 일시적으로 원활하지 않아");
    expect(html).toContain("답변을 저장하지 못했습니다");
  });

  it("단락별 페이지 출처를 제거하고 문장부호와 비출처 표식은 보존한다", () => {
    const answer =
      "보호복을 점검합니다 [화학보호복 교범 p.3].\n\n" +
      "2인 1조로 확인합니다 [근거: 화학보호복 교범 p.3], [출처：화학보호복 교범 p.4].\n" +
      "[안전 유의] 이상이 있으면 중단합니다 [확인 문서 p.-].";

    const prepared = prepareChatAnswerText(answer);

    expect(prepared).toContain("보호복을 점검합니다.");
    expect(prepared).toContain("2인 1조로 확인합니다.");
    expect(prepared).toContain("[안전 유의] 이상이 있으면 중단합니다.");
    expect(prepared).not.toMatch(/\[[^\]\r\n]*\bp\s*\.?\s*(?:\d+|-)[^\]\r\n]*\]/i);
    expect(prepared).not.toMatch(/\s+[,.]/);
  });

  it("같은 문서·페이지는 한 번만 남기고 다른 페이지는 유지한다", () => {
    const unique = uniqueChatSources(sources);

    expect(unique.map((source) => [source.doc, source.page])).toEqual([
      ["화학보호복 교범", 3],
      ["화학보호복 교범", 4],
    ]);
  });

  it("과거 인라인 인용도 숨기고 답변 마지막에 근거 자료만 한 번 표시한다", () => {
    const message: Message = {
      id: "assistant-1",
      role: "assistant",
      content:
        "착용 전 외관을 확인합니다 [화학보호복 교범 p.3].\n\n" +
        "이상이 있으면 중단합니다 [가짜 교범 p.999].",
      annotations: [{ messageId: 1, sources }],
    };
    const html = renderToStaticMarkup(createElement(MessageBubble, { message }));

    expect(html).toContain("착용 전 외관을 확인합니다.");
    expect(html).toContain("이상이 있으면 중단합니다.");
    expect(html).not.toContain("가짜 교범");
    expect(html).toContain(`aria-label="${CHAT_SOURCE_SECTION_TITLE}"`);
    expect(html.match(/>근거 자료<\/span>/g)).toHaveLength(1);
    expect(html.match(/화학보호복 교범 p\.3/g)).toHaveLength(1);
    expect(html.match(/화학보호복 교범 p\.4/g)).toHaveLength(1);
    expect(html.indexOf(CHAT_SOURCE_SECTION_TITLE)).toBeGreaterThan(
      html.indexOf("이상이 있으면 중단합니다.")
    );
  });

  it("데모 답변도 본문 인라인 출처를 만들지 않는다", () => {
    expect(demoChatAnswer).not.toMatch(/\[[^\]\r\n]*\bp\s*\.?\s*\d+[^\]\r\n]*\]/i);
  });
});
