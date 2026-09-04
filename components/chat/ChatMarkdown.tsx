"use client";

import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 원문 HTML은 실행하지 않는다. 모델이 만든 외부 이미지는 자동 요청하지 않고
// 대체 설명만 보여 주며, 링크에는 react-markdown의 기본 URL 검증을 유지한다.
const components: Components = {
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-lg font-bold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-lg font-bold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-bold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-primary/50 pl-3">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border" />,
  a: ({ href, children }) => href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-primary underline underline-offset-4">
      {children}<span className="sr-only"> (새 탭)</span>
    </a>
  ) : <span>{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[이미지 설명: ${alt}]` : "[이미지]"}</span>,
  table: ({ children }) => (
    <div role="region" aria-label="답변 표, 좌우로 스크롤할 수 있습니다" tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <table className="w-full min-w-[24rem] border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b bg-background/70 px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b px-3 py-2 align-top last:border-b-0">{children}</td>,
  pre: ({ children }) => <pre tabIndex={0} aria-label="코드, 좌우로 스크롤할 수 있습니다" className="my-3 max-w-full overflow-x-auto rounded-md bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</pre>,
  code: ({ children }) => <code className="rounded bg-background/70 px-1 font-mono text-[0.9em]">{children}</code>,
};

const plugins = [remarkGfm];

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={plugins} components={components} skipHtml>{text}</Markdown>;
});
