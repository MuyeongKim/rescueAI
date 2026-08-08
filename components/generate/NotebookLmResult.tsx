"use client";

// NotebookLM 프롬프트 결과 — AI 호출 없이 클라이언트에서 조립한 텍스트를 보여주고 복사시킨다.
import { Check, Copy, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AccentBar, SaveButton, type ResultChrome } from "@/components/generate/parts";

export function NotebookLmResult({
  prompt,
  chrome,
  copied,
  onCopy,
}: {
  prompt: string;
  chrome: ResultChrome;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <Card className="animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none">
      <AccentBar accent={chrome.accent} />
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
          {prompt}
        </pre>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="h-12 flex-1 gap-2 text-base"
            onClick={() => onCopy(prompt)}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            프롬프트 복사
          </Button>
          <div className="flex-1 [&>button]:h-12 [&>button]:w-full [&>button]:text-base">
            <SaveButton chrome={chrome} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
