"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  LogIn,
  Mail,
  MailCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/client";

function loginErrorMessage(message: string, magicMode: boolean): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid login credentials")) {
    return "이메일 또는 비밀번호를 확인한 뒤 다시 시도해 주세요.";
  }
  if (normalized.includes("rate") || normalized.includes("too many")) {
    return "요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
  return magicMode
    ? "로그인 링크를 보내지 못했습니다. 이메일 주소를 확인하고 다시 시도해 주세요."
    : "로그인하지 못했습니다. 입력 내용을 확인하거나 잠시 후 다시 시도해 주세요.";
}

export default function LoginForm() {
  const searchParams = useSearchParams();
  // 외부 URL·javascript: 스킴을 걸러 앱 내부 경로만 남긴다(오픈 리다이렉트 차단).
  const redirect = safeRedirectPath(searchParams.get("redirect"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicMode, setMagicMode] = useState(false);
  const [sent, setSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;

    setFormError(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password,
      });
      if (error) {
        setFormError(loginErrorMessage(error.message, false));
        return;
      }
      window.location.assign(redirect);
    } catch (err) {
      setFormError(
        loginErrorMessage(
          err instanceof Error ? err.message : String(err),
          false
        )
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setFormError(null);
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
        setFormError(loginErrorMessage(error.message, true));
        return;
      }
      setSent(true);
    } catch (err) {
      setFormError(
        loginErrorMessage(
          err instanceof Error ? err.message : String(err),
          true
        )
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full">
      <div className="login-form-heading mb-5 border-b border-slate-300 pb-4 sm:mb-7 sm:pb-5 dark:border-slate-700">
        <p className="flex items-center gap-2 text-xs font-bold text-primary">
          <span className="h-0.5 w-7 bg-primary" aria-hidden />
          승인 계정 접속
        </p>
        <h2 className="mt-2 text-xl font-extrabold text-slate-950 sm:text-2xl dark:text-slate-50">
          대원 로그인
        </h2>
        <p className="mt-1.5 text-base leading-6 text-muted-foreground sm:text-sm">
          발급받은 공직자 계정으로 구조 교육훈련 시스템에 접속하세요.
        </p>
      </div>

      {sent ? (
        <div
          role="status"
          className="border border-slate-300 border-l-4 border-l-primary bg-card px-6 py-8 text-center dark:border-slate-700 dark:border-l-primary"
        >
          <span className="mx-auto flex h-12 w-12 items-center justify-center border border-primary/30 bg-primary/5">
            <MailCheck className="h-6 w-6 text-primary" aria-hidden />
          </span>
          <p className="mt-4 text-base font-bold">이메일을 확인하세요</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            <span className="font-semibold text-foreground [overflow-wrap:anywhere]">
              {email}
            </span>
            으로 로그인 링크를 보냈습니다.
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
          className="login-form-fields space-y-4"
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
              onChange={(e) => {
                setEmail(e.target.value);
                setFormError(null);
              }}
              className="h-[52px] border-slate-300 bg-white px-4 text-base dark:border-slate-700 dark:bg-slate-950"
              disabled={loading}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? "login-error" : undefined}
            />
          </div>

          {!magicMode ? (
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
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setFormError(null);
                  }}
                  className="h-[52px] border-slate-300 bg-white px-4 pr-14 text-base dark:border-slate-700 dark:bg-slate-950"
                  disabled={loading}
                  aria-invalid={formError ? true : undefined}
                  aria-describedby={formError ? "login-error" : undefined}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" aria-hidden />
                  ) : (
                    <Eye className="h-5 w-5" aria-hidden />
                  )}
                </button>
              </div>
            </div>
          ) : null}

          {formError ? (
            <p
              id="login-error"
              role="alert"
              className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm leading-5 text-destructive"
            >
              {formError}
            </p>
          ) : null}

          <Button
            type="submit"
            className="h-[52px] w-full text-base font-bold"
            disabled={loading}
          >
            {loading ? (
              <Loader2
                className="h-5 w-5 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : magicMode ? (
              <Mail className="h-5 w-5" aria-hidden />
            ) : (
              <LogIn className="h-5 w-5" aria-hidden />
            )}
            {magicMode ? "로그인 링크 받기" : "로그인"}
          </Button>

          <button
            type="button"
            className="flex min-h-12 w-full items-center justify-center gap-2 text-center text-sm font-medium text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setMagicMode((enabled) => !enabled);
              setFormError(null);
            }}
          >
            {magicMode ? (
              <LockKeyhole className="h-4 w-4" aria-hidden />
            ) : (
              <Mail className="h-4 w-4" aria-hidden />
            )}
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
