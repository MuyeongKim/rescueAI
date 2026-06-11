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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function LoginForm() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/home";

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
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
      const emailRedirectTo = `${origin}/auth/callback?redirect=${encodeURIComponent(
        redirect
      )}`;

      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo },
      });

      if (error) {
        toast.error("로그인 링크 전송 실패", { description: error.message });
        return;
      }
      setSent(true);
      toast.success("로그인 링크를 보냈습니다", {
        description: "이메일의 링크를 눌러 로그인하세요.",
      });
    } catch (err) {
      toast.error("오류가 발생했습니다", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-2 text-center">
        <Image
          src="/logo-jbfire.png"
          alt="소방 엠블럼"
          width={120}
          height={59}
          priority
          className="mx-auto"
        />
        <p className="text-sm font-medium text-muted-foreground">
          전북특별자치도 소방본부
        </p>
        <CardTitle className="text-xl">전북소방 구조 AI</CardTitle>
        <CardDescription className="text-base">
          구조대원 교육훈련 플랫폼 — 학습·AI 튜터·자료 생성·체력단련
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <MailCheck className="h-10 w-10 text-primary" />
            <p className="text-base font-medium">이메일을 확인하세요</p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{email}</span> 으로
              로그인 링크를 보냈습니다.
            </p>
            <Button
              variant="ghost"
              className="mt-2 h-11"
              onClick={() => setSent(false)}
            >
              다른 이메일로 다시 시도
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
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
            <Button
              type="submit"
              className="h-12 w-full text-base"
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              로그인 링크 받기
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              계정은 관리자가 발급합니다. 등록된 이메일로만 로그인할 수 있습니다.
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Suspense
        fallback={
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> 불러오는 중…
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
