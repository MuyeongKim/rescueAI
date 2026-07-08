"use client";

import { Suspense, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MailCheck } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/home";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // 매직링크는 보조 수단 (비밀번호 미발급 계정용)
  const [magicMode, setMagicMode] = useState(false);
  const [sent, setSent] = useState(false);

  // 기본: 이메일 + 비밀번호 로그인 (메일 발송 없음)
  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;

    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password,
      });
      if (error) {
        toast.error("로그인 실패", {
          description:
            error.message === "Invalid login credentials"
              ? "이메일 또는 비밀번호가 올바르지 않습니다."
              : error.message,
        });
        return;
      }
      // 서버(미들웨어)가 새 세션 쿠키를 읽도록 전체 이동
      window.location.assign(redirect);
    } catch (err) {
      toast.error("오류가 발생했습니다", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const supabase = createClient();
      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : process.env.NEXT_PUBLIC_SITE_URL || "";
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: `${origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
        },
      });
      if (error) {
        toast.error("로그인 링크 전송 실패", { description: error.message });
        return;
      }
      setSent(true);
    } catch (err) {
      toast.error("오류가 발생했습니다", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center md:hidden">
        <h1 className="text-2xl font-extrabold tracking-tight">전북소방 구조 AI</h1>
        <p className="mt-1 text-sm text-muted-foreground">구조대원 교육훈련 플랫폼</p>
      </div>

      <div className="mb-6 hidden md:block">
        <h2 className="text-2xl font-extrabold tracking-tight">로그인</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          공직자 이메일과 비밀번호로 로그인하세요.
        </p>
      </div>

      {sent ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border bg-card py-8 text-center">
          <MailCheck className="h-10 w-10 text-primary" />
          <p className="text-base font-medium">이메일을 확인하세요</p>
          <p className="px-6 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{email}</span> 으로 로그인
            링크를 보냈습니다.
          </p>
          <Button
            variant="ghost"
            className="mt-2 h-11"
            onClick={() => {
              setSent(false);
              setMagicMode(false);
            }}
          >
            비밀번호로 로그인
          </Button>
        </div>
      ) : (
        <form
          onSubmit={magicMode ? handleMagicLink : handlePasswordLogin}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="email" className="text-base">
              이메일
            </Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              placeholder="name@jbfire.go.kr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 text-base"
              disabled={loading}
            />
          </div>
          {!magicMode && (
            <div className="space-y-2">
              <Label htmlFor="password" className="text-base">
                비밀번호
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 text-base"
                disabled={loading}
              />
            </div>
          )}
          <Button
            type="submit"
            className="h-12 w-full text-base font-semibold"
            disabled={loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {magicMode ? "로그인 링크 받기" : "로그인"}
          </Button>
          <button
            type="button"
            className="block w-full text-center text-sm text-muted-foreground hover:text-primary"
            onClick={() => setMagicMode(!magicMode)}
          >
            {magicMode
              ? "비밀번호로 로그인"
              : "비밀번호가 없나요? 이메일 링크로 로그인"}
          </button>
          <p className="text-center text-xs text-muted-foreground">
            계정은 관리자가 발급합니다. 등록된 이메일로만 로그인할 수 있습니다.
          </p>
        </form>
      )}
    </div>
  );
}

const CAPABILITIES = ["AI 튜터", "AI 자료제작", "자료실", "체력단련"];

// 왼쪽(데스크톱)·상단(모바일) 히어로 — 소방 아이덴티티. 출동 신호처럼 퍼지는 비컨 + 오로라 드리프트.
function LoginHero() {
  return (
    <div
      className="hero-aurora relative flex flex-col justify-between overflow-hidden px-8 py-10 text-white md:px-12 md:py-14"
      style={{
        backgroundImage:
          "radial-gradient(circle at 28% 18%, rgba(204,63,20,0.42), transparent 46%)," +
          "radial-gradient(circle at 78% 82%, rgba(37,58,110,0.55), transparent 52%)," +
          "linear-gradient(135deg, #0a1020 0%, #0e1730 58%, #170f26 100%)",
      }}
    >
      {/* 안전 테이프 상단 액센트(기존 시그니처 재사용) */}
      <div className="hazard-stripe absolute inset-x-0 top-0 h-1.5 text-primary" aria-hidden />

      <div className="anim-rise relative z-10 flex items-center gap-3" style={{ animationDelay: "0.05s" }}>
        <span className="inline-flex rounded-lg bg-white/95 p-1.5 shadow-sm">
          <Image src="/logo-jbfire.png" alt="전북소방 엠블럼" width={104} height={51} priority />
        </span>
      </div>

      {/* 시그니처 — 비컨(동심원) 확산 신호 */}
      <div className="pointer-events-none absolute right-6 top-1/2 hidden -translate-y-1/2 md:block" aria-hidden>
        <div className="relative h-56 w-56">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="beacon-ring absolute inset-0 rounded-full border border-primary/50"
              style={{ animationDelay: `${i * 1.13}s` }}
            />
          ))}
          <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_20px_6px_rgba(204,63,20,0.6)]" />
        </div>
      </div>

      <div className="relative z-10 space-y-4">
        <p
          className="anim-rise text-xs font-semibold uppercase tracking-[0.2em] text-white/60"
          style={{ animationDelay: "0.12s" }}
        >
          전북특별자치도 소방본부
        </p>
        <h1
          className="anim-rise text-3xl font-extrabold leading-tight tracking-tight md:text-[2.6rem]"
          style={{ animationDelay: "0.2s" }}
        >
          현장을 준비하는
          <br />
          구조대원의 훈련 플랫폼
        </h1>
        <div className="anim-rise flex flex-wrap gap-2 pt-1" style={{ animationDelay: "0.3s" }}>
          {CAPABILITIES.map((c) => (
            <span
              key={c}
              className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-sm"
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      <p className="anim-rise relative z-10 hidden text-xs text-white/45 md:block" style={{ animationDelay: "0.4s" }}>
        인덱싱된 교육자료에 근거해 답하고, 근거가 없으면 알려드립니다.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen md:grid md:grid-cols-[1.05fr_1fr]">
      <LoginHero />
      <div className="flex min-h-[60vh] items-center justify-center bg-background px-4 py-10 md:min-h-screen">
        <Suspense
          fallback={
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> 불러오는 중…
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
