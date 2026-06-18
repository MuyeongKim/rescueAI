"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_LEN) {
      toast.error(`비밀번호는 ${MIN_LEN}자 이상이어야 합니다.`);
      return;
    }
    if (password !== confirm) {
      toast.error("비밀번호가 일치하지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error("세션이 만료되었습니다. 다시 로그인하세요.");
        window.location.assign("/login");
        return;
      }

      // 1) 비밀번호 변경
      const { error: pwErr } = await supabase.auth.updateUser({ password });
      if (pwErr) {
        toast.error("비밀번호 변경 실패", { description: pwErr.message });
        return;
      }

      // 2) 변경 강제 플래그 해제 (본인 profiles 행 — RLS "own profile update" 허용)
      const { error: profErr } = await supabase
        .from("profiles")
        .update({ must_change_password: false })
        .eq("id", user.id);
      if (profErr) {
        // 비번은 이미 바뀜 — 플래그만 못 내린 경우. 재시도 안내.
        toast.error("설정 저장 실패", { description: profErr.message });
        return;
      }

      toast.success("비밀번호가 변경되었습니다.");
      // 서버(미들웨어)가 갱신된 상태를 읽도록 전체 이동
      window.location.assign("/home");
    } catch (err) {
      toast.error("오류가 발생했습니다", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
          <CardTitle className="text-xl">비밀번호 변경</CardTitle>
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
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                placeholder={`${MIN_LEN}자 이상`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 text-base"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm" className="text-base">
                새 비밀번호 확인
              </Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                placeholder="다시 입력"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
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
              변경하고 시작하기
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
