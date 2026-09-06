"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, BookOpen, FileText, Loader2, MessageSquare, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { USER_GUIDE_QUICK_STEPS, USER_GUIDE_VERSION } from "@/lib/user-guide-content";
import { useGuideSession } from "./GuideSessionProvider";

type GuideState = {
  version: string;
  shouldShow: boolean;
  hideForVersion: boolean;
  available: boolean;
};

const STEP_ICONS = [MessageSquare, Wand2, FileText];
const INTRO_PATHS = ["/home", "/chat", "/generate", "/docs", "/news", "/notices", "/me", "/admin"];

function isGuideState(value: unknown): value is GuideState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GuideState>;
  return state.version === USER_GUIDE_VERSION &&
    typeof state.shouldShow === "boolean" &&
    typeof state.hideForVersion === "boolean" &&
    typeof state.available === "boolean";
}

async function readGuideState(signal: AbortSignal): Promise<GuideState> {
  const response = await fetch("/api/user-guide", { cache: "no-store", signal });
  if (!response.ok) throw new Error("guide_read_failed");
  const data: unknown = await response.json();
  if (!isGuideState(data)) throw new Error("guide_state_invalid");
  return data;
}

/** 자동 안내와 설명서의 수동 다시 보기는 같은 본문·계정 설정을 사용한다. */
export function UserGuideOnboarding({ automatic = true }: { automatic?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { dismissed, dismiss } = useGuideSession();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [available, setAvailable] = useState(false);
  const [hideForVersion, setHideForVersion] = useState(false);
  const [hideChanged, setHideChanged] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    // 설명서·로그인·비밀번호 변경 화면은 자동 안내로 가리지 않는다.
    if (!automatic) return;
    if (!INTRO_PATHS.some((path) => pathname === path || pathname.startsWith(path + "/"))) {
      setOpen(false);
      return;
    }
    if (dismissed) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
    void readGuideState(controller.signal).then((state) => {
      if (controller.signal.aborted) return;
      setAvailable(state.available);
      setHideForVersion(state.hideForVersion);
      setHideChanged(false);
      setOpen(state.available && state.shouldShow);
    }).catch(() => {
      // 도움말 설정 장애가 로그인이나 본래 업무를 막지 않도록 한다.
    }).finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [automatic, pathname, dismissed]);

  async function openManually() {
    if (loading) return;
    setLoading(true);
    setHideChanged(false);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6_000);
    try {
      const state = await readGuideState(controller.signal);
      setAvailable(state.available);
      setHideForVersion(state.hideForVersion);
    } catch {
      setAvailable(false);
      setHideForVersion(false);
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
      setOpen(true);
    }
  }

  async function finish(href?: string) {
    if (closingRef.current) return;
    closingRef.current = true;
    dismiss();
    setSaving(true);
    // Esc와 닫기로 바로 업무로 돌아갈 수 있다. 저장 실패는 별도로 알린다.
    setOpen(false);
    // 목적지 이동을 Auth 응답 뒤로 미루면 사용자의 다음 이동을 덮어쓸 수 있다.
    if (href) router.push(href);
    if (available) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 6_000);
      try {
        const response = await fetch("/api/user-guide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: USER_GUIDE_VERSION, ...(hideChanged ? { hideForVersion } : {}) }),
          signal: controller.signal,
        });
        const state: unknown = await response.json();
        if (!response.ok || !isGuideState(state) || !state.available || state.shouldShow ||
            (hideChanged && state.hideForVersion !== hideForVersion)) throw new Error("guide_save_failed");
      } catch {
        toast.error("안내 설정을 저장하지 못했습니다. 다음 접속 때 다시 나타날 수 있습니다.");
      } finally {
        window.clearTimeout(timeout);
      }
    }
    closingRef.current = false;
    setSaving(false);
  }

  return (
    <>
      {!automatic && (
        <Button ref={triggerRef} variant="outline" className="min-h-12 gap-2 text-base" disabled={loading} aria-disabled={saving || undefined} onClick={() => { if (!saving) void openManually(); }}>
          {loading ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <BookOpen className="h-5 w-5" aria-hidden />}
          {loading ? "안내 여는 중" : "빠른 안내 다시 보기"}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) void finish(); }}>
        <DialogPortal>
          <DialogOverlay className="bg-slate-950/65 motion-reduce:animate-none" />
          <DialogPrimitive.Content
            className="guide-intro-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl focus:outline-none sm:max-h-[90dvh]"
            onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (triggerRef.current ?? document.getElementById("main-content"))?.focus({ preventScroll: true });
            }}
          >
            <header className="relative shrink-0 border-b border-border border-t-4 border-t-primary px-5 py-5 pr-16 sm:px-8 sm:pr-20">
              <p className="mb-2 text-sm font-bold text-primary">처음 이용 안내 · 1분 읽기</p>
              <DialogTitle ref={headingRef} tabIndex={-1} className="text-2xl font-extrabold leading-snug tracking-tight focus:outline-none sm:text-3xl">
                구조 AI, 이렇게 시작하세요
              </DialogTitle>
              <DialogDescription className="mt-2 text-base leading-relaxed text-muted-foreground">
                질문하고, 교육자료를 만들고, 원본을 확인할 수 있습니다.
              </DialogDescription>
              <button type="button" onClick={() => void finish()} aria-label="시작 안내 닫기" className="absolute right-2 top-3 flex h-12 w-12 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-4">
                <X className="h-6 w-6" aria-hidden />
              </button>
            </header>

            <div className="guide-intro-body min-h-0 overflow-y-auto overscroll-contain px-5 py-2 sm:px-8">
              <ul className="divide-y divide-border">
                {USER_GUIDE_QUICK_STEPS.map((step, index) => {
                  const Icon = STEP_ICONS[index] ?? BookOpen;
                  return (
                    <li key={step.href} className="flex gap-4 py-5">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden><Icon className="h-6 w-6" /></span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-lg font-bold">{step.title}</h3>
                        <p className="mt-1 text-base leading-relaxed text-muted-foreground">{step.description}</p>
                        <button type="button" onClick={() => void finish(step.href)} className="mt-1 inline-flex min-h-12 items-center gap-2 rounded-sm text-base font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {step.label}<ArrowRight className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mb-5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-base leading-relaxed">
                AI 답변과 만든 자료는 <strong>출처를 확인한 뒤</strong> 사용하세요.
                하던 작업은 자료제작 화면 아래의 <strong>이어서 작업하기</strong>에서 찾을 수 있습니다.
              </p>
            </div>

            <footer className="shrink-0 border-t border-border bg-background px-5 py-4 sm:px-8">
                <label className={`mb-2 flex min-h-12 items-center gap-3 text-base ${available ? "cursor-pointer" : "text-muted-foreground"}`}>
                  <input type="checkbox" checked={hideForVersion} disabled={!available} onChange={(event) => { setHideForVersion(event.target.checked); setHideChanged(true); }} className="h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
                  이번 안내 다시 보지 않기
                </label>
              {!available && (
                <p className="mb-3 text-sm leading-relaxed text-muted-foreground">지금은 안내 확인 설정을 저장할 수 없습니다. 설명서는 바로 읽을 수 있습니다.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" className="min-h-12 flex-1 text-base" onClick={() => void finish()}>시작하기</Button>
                <Button type="button" variant="outline" className="min-h-12 flex-1 text-base" onClick={() => void finish("/guide")}>전체 설명서 보기</Button>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">주메뉴의 ‘사용설명서’에서 언제든 다시 볼 수 있습니다.</p>
            </footer>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </>
  );
}
