"use client";

import { Suspense, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Database,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  LogIn,
  Mail,
  MailCheck,
  ShieldCheck,
} from "lucide-react";

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
  const [magicMode, setMagicMode] = useState(false);
  const [sent, setSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="w-full max-w-md">
      <div className="mb-7 border-b border-slate-300 pb-5 dark:border-slate-700">
        <p className="flex items-center gap-2 text-[11px] font-bold text-primary">
          <span className="h-0.5 w-7 bg-primary" aria-hidden />
          내부 보안 접속
        </p>
        <h2 className="mt-2 text-2xl font-extrabold text-slate-950 dark:text-slate-50">
          대원 로그인
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          발급받은 공직자 계정으로 구조 교육훈련 시스템에 접속하세요.
        </p>
      </div>

      {sent ? (
        <div className="border border-slate-300 border-l-4 border-l-primary bg-card px-6 py-8 text-center dark:border-slate-700 dark:border-l-primary">
          <span className="mx-auto flex h-12 w-12 items-center justify-center border border-primary/30 bg-primary/5">
            <MailCheck className="h-6 w-6 text-primary" />
          </span>
          <p className="mt-4 text-base font-bold">이메일을 확인하세요</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            <span className="font-semibold text-foreground">{email}</span>으로 로그인
            링크를 보냈습니다.
          </p>
          <Button
            variant="outline"
            className="mt-5 h-12 w-full"
            onClick={() => {
              setSent(false);
              setMagicMode(false);
            }}
          >
            <LockKeyhole className="h-4 w-4" />
            비밀번호로 로그인
          </Button>
        </div>
      ) : (
        <form
          onSubmit={magicMode ? handleMagicLink : handlePasswordLogin}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-semibold">
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
              className="h-[52px] border-slate-300 bg-white px-4 text-base dark:border-slate-700 dark:bg-slate-950"
              disabled={loading}
            />
          </div>

          {!magicMode && (
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-semibold">
                비밀번호
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder="비밀번호"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-[52px] border-slate-300 bg-white px-4 pr-12 text-base dark:border-slate-700 dark:bg-slate-950"
                  disabled={loading}
                />
                <button
                  type="button"
                  className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>
          )}

          <Button
            type="submit"
            className="h-[52px] w-full text-base font-bold"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : magicMode ? (
              <Mail className="h-5 w-5" />
            ) : (
              <LogIn className="h-5 w-5" />
            )}
            {magicMode ? "로그인 링크 받기" : "로그인"}
          </Button>

          <button
            type="button"
            className="flex min-h-12 w-full items-center justify-center gap-2 text-center text-sm font-medium text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setMagicMode((enabled) => !enabled)}
          >
            {magicMode ? <LockKeyhole className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
            {magicMode ? "비밀번호로 로그인" : "이메일 링크로 로그인"}
          </button>

          <p className="border-t border-slate-200 pt-4 text-center text-xs leading-5 text-muted-foreground dark:border-slate-800">
            계정은 관리자가 발급하며 등록된 이메일만 사용할 수 있습니다.
          </p>
        </form>
      )}
    </div>
  );
}

function LoginHero() {
  return (
    <section className="command-grid relative flex min-h-[340px] flex-col overflow-hidden bg-[#0b1426] px-6 py-8 text-white sm:px-8 md:min-h-screen md:px-12 md:py-12 lg:px-16">
      <div className="hazard-stripe absolute inset-x-0 top-0 h-1.5 text-[#d63f18]" aria-hidden />
      <div
        className="command-scan-line pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-[#f0542d] shadow-[0_0_18px_2px_rgba(240,84,45,0.45)]"
        aria-hidden
      />

      <div className="pointer-events-none absolute -right-32 top-[20%] h-[420px] w-[420px] rounded-full border border-[#d63f18]/25 md:-right-24 md:top-[26%]" aria-hidden>
        <span className="absolute inset-[72px] rounded-full border border-[#d63f18]/20" />
        <span className="absolute inset-[145px] rounded-full border border-[#d63f18]/20" />
        <span className="absolute left-1/2 top-1/2 h-px w-1/2 -translate-y-1/2 bg-[#d63f18]/60 command-radar-sweep origin-left" />
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f0542d] shadow-[0_0_18px_5px_rgba(240,84,45,0.35)]" />
      </div>

      <div className="anim-rise relative z-10 flex items-center gap-3" style={{ animationDelay: "0.05s" }}>
        <span className="flex h-12 w-[88px] items-center justify-center bg-white px-2">
          <Image src="/logo-jbfire.png" alt="전북소방 엠블럼" width={76} height={38} priority />
        </span>
        <div>
          <p className="text-xs text-slate-400">전북특별자치도 소방본부</p>
          <p className="mt-0.5 text-sm font-bold text-white">전북소방 구조 AI</p>
        </div>
      </div>

      <div className="relative z-10 my-auto max-w-xl py-10 md:py-14">
        <p className="anim-rise text-xs font-bold text-[#ff8a66]" style={{ animationDelay: "0.12s" }}>
          구조 대응 준비 시스템
        </p>
        <h1
          className="anim-rise mt-4 text-3xl font-black leading-[1.22] text-white sm:text-4xl lg:text-[44px]"
          style={{ animationDelay: "0.2s" }}
        >
          현장을 준비하는
          <br />
          구조대원의 훈련 플랫폼
        </h1>
        <p
          className="anim-rise mt-5 max-w-md text-sm leading-7 text-slate-300 sm:text-base"
          style={{ animationDelay: "0.28s" }}
        >
          구조 매뉴얼의 근거를 확인하고 훈련에 필요한 자료를 신속하게 준비합니다.
        </p>

        <div className="anim-rise mt-7 flex flex-wrap gap-2" style={{ animationDelay: "0.36s" }}>
          <span className="flex min-h-10 items-center gap-2 border border-slate-600 bg-[#101e34] px-3 text-xs text-slate-200">
            <Database className="h-4 w-4 text-emerald-400" />
            교육자료 연결
          </span>
          <span className="flex min-h-10 items-center gap-2 border border-slate-600 bg-[#101e34] px-3 text-xs text-slate-200">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            내부 보안 접속
          </span>
        </div>
      </div>

      <div className="relative z-10 hidden items-end justify-between border-t border-slate-700 pt-5 text-[11px] text-slate-400 md:flex">
        <p>
          인덱싱된 교육자료에 근거해 답하고
          <br />
          확인되지 않은 내용은 추측하지 않습니다.
        </p>
        <p className="text-right">
          RESCUE AI / JB-119
          <br />
          SECURE ACCESS
        </p>
      </div>
    </section>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(420px,0.8fr)]">
      <LoginHero />
      <section className="relative flex min-h-[60vh] items-center justify-center bg-background px-5 py-10 sm:px-8 md:min-h-screen md:px-10">
        <div className="absolute inset-y-0 left-0 hidden w-1 bg-primary md:block" aria-hidden />
        <Suspense
          fallback={
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> 불러오는 중…
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
