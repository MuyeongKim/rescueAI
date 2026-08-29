"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const MIN_LEN = 8;

export default function ChangePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const nextPasswordError =
      password.length < MIN_LEN
        ? `비밀번호를 ${MIN_LEN}자 이상 입력해 주세요.`
        : null;
    const nextConfirmError =
      password !== confirm ? "새 비밀번호와 동일하게 입력해 주세요." : null;
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);

    if (nextPasswordError) {
      passwordRef.current?.focus();
      return;
    }
    if (nextConfirmError) {
      confirmRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setFormError("로그인 시간이 만료되었습니다. 다시 로그인해 주세요.");
        window.location.assign("/login");
        return;
      }

      // 1) 비밀번호 변경
      const { error: pwErr } = await supabase.auth.updateUser({ password });
      if (pwErr) {
        setFormError(
          "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요."
        );
        return;
      }

      // 2) 변경 강제 플래그 해제 (본인 profiles 행 — RLS "own profile update" 허용)
      const { error: profErr } = await supabase
        .from("profiles")
        .update({ must_change_password: false })
        .eq("id", user.id);
      if (profErr) {
        // 비번은 이미 바뀜 — 플래그만 못 내린 경우. 재시도 안내.
        setFormError(
          "비밀번호는 변경되었지만 설정을 저장하지 못했습니다. 새 비밀번호로 다시 로그인해 주세요."
        );
        return;
      }

      toast.success("비밀번호가 변경되었습니다.");
      // 서버(미들웨어)가 갱신된 상태를 읽도록 전체 이동
      window.location.assign("/home");
    } catch {
      setFormError(
        "네트워크 문제로 변경하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-primary" aria-hidden />
          <CardTitle asChild className="text-xl">
            <h1>비밀번호 변경</h1>
          </CardTitle>
          <CardDescription className="text-base">
            처음 로그인하셨습니다. 보안을 위해 초기 비밀번호(디지털식별번호)를
            새 비밀번호로 변경해 주세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-base">
                새 비밀번호
              </Label>
              <div className="relative">
                <Input
                  ref={passwordRef}
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder={`${MIN_LEN}자 이상`}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordError(null);
                    setFormError(null);
                  }}
                  onBlur={() => {
                    if (password && password.length < MIN_LEN) {
                      setPasswordError(`비밀번호를 ${MIN_LEN}자 이상 입력해 주세요.`);
                    }
                  }}
                  className="h-12 pr-12 text-base"
                  disabled={loading}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={`password-hint${passwordError ? " password-error" : ""}`}
                />
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "새 비밀번호 숨기기" : "새 비밀번호 보기"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" aria-hidden />
                  ) : (
                    <Eye className="h-5 w-5" aria-hidden />
                  )}
                </button>
              </div>
              <p id="password-hint" className="text-sm text-muted-foreground">
                {MIN_LEN}자 이상 입력하세요. 다른 서비스와 다른 비밀번호를 권장합니다.
              </p>
              {passwordError && (
                <p id="password-error" role="alert" className="text-sm text-destructive">
                  {passwordError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm" className="text-base">
                새 비밀번호 확인
              </Label>
              <div className="relative">
                <Input
                  ref={confirmRef}
                  id="confirm"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  placeholder="다시 입력"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setConfirmError(null);
                    setFormError(null);
                  }}
                  onBlur={() => {
                    if (confirm && password !== confirm) {
                      setConfirmError("새 비밀번호와 동일하게 입력해 주세요.");
                    }
                  }}
                  className="h-12 pr-12 text-base"
                  disabled={loading}
                  aria-invalid={confirmError ? true : undefined}
                  aria-describedby={confirmError ? "confirm-error" : undefined}
                />
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowConfirm((visible) => !visible)}
                  aria-label={showConfirm ? "비밀번호 확인 숨기기" : "비밀번호 확인 보기"}
                  aria-pressed={showConfirm}
                >
                  {showConfirm ? (
                    <EyeOff className="h-5 w-5" aria-hidden />
                  ) : (
                    <Eye className="h-5 w-5" aria-hidden />
                  )}
                </button>
              </div>
              {confirmError && (
                <p id="confirm-error" role="alert" className="text-sm text-destructive">
                  {confirmError}
                </p>
              )}
            </div>
            {formError && (
              <p
                role="alert"
                className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm leading-5 text-destructive"
              >
                {formError}
              </p>
            )}
            <Button
              type="submit"
              className="h-12 w-full text-base"
              disabled={loading}
            >
              {loading && (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              변경하고 시작하기
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
