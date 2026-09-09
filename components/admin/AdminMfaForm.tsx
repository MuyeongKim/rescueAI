"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdminMfaStatus } from "@/lib/auth";

type Enrollment = { factorId: string; qrCode: string; secret: string };
type Status = AdminMfaStatus & { demo?: boolean };
const endpoint = "/api/auth/admin-mfa";

async function request(body?: Record<string, string>) {
  const response = await fetch(endpoint, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  } : { cache: "no-store" });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.error ?? (response.status === 403 ? "접근 권한을 확인하지 못했습니다. 다시 로그인하거나 관리자에게 문의해 주세요." : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
  }
  return result;
}

export function AdminMfaForm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [factorId, setFactorId] = useState("");
  const [name, setName] = useState("기본 인증 앱");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const next = await request() as Status;
    setStatus(next);
    setFactorId(next.factors.find((factor) => factor.status === "verified")?.id ?? "");
    if (next.factors.some((factor) => factor.status === "verified")) setName("예비 인증 앱");
  }, []);
  useEffect(() => { void refresh().catch(() => setError("인증 상태를 불러오지 못했습니다. 다시 시도해 주세요.")); }, [refresh]);
  useEffect(() => { if (enrollment) codeRef.current?.focus(); }, [enrollment]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "연결을 확인한 뒤 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  async function enroll() {
    await perform(async () => {
      const result = await request({ action: "enroll", name });
      setEnrollment(result.enrollment); setCode("");
    });
  }
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    await perform(async () => {
      await request({ action: "verify", factorId: enrollment?.factorId ?? factorId, code });
      setEnrollment(null); setCode("");
      await refresh();
      setNotice("추가 인증을 완료했습니다. 관리자 화면을 이용할 수 있습니다.");
    });
  }
  async function cancel(id: string) {
    await perform(async () => {
      await request({ action: "cancel", factorId: id });
      if (enrollment?.factorId === id) { setEnrollment(null); setCode(""); }
      await refresh();
      setNotice("미완료 등록을 취소했습니다.");
    });
  }
  const verifiedFactors = status?.factors.filter((factor) => factor.status === "verified") ?? [];
  const pendingFactors = status?.factors.filter((factor) => factor.status === "unverified") ?? [];
  const needsVerify = enrollment !== null || (!!status && !status.verified && verifiedFactors.length > 0);

  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-muted/30 px-4 py-8">
      <Card className="w-full max-w-lg">
        <CardHeader className="space-y-3">
          <ShieldCheck className="h-9 w-9 text-primary" aria-hidden />
          <CardTitle asChild className="text-2xl"><h1>관리자 추가 인증</h1></CardTitle>
          <CardDescription className="text-base leading-relaxed">
            사용자·자료 관리에는 인증 앱의 6자리 번호가 필요합니다. AI 튜터와 자료제작은 홈에서 계속 이용할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5" aria-busy={busy}>
          {!status && !error && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />인증 상태 확인 중</p>}
          {error && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"><p>{error}</p>{!status && <Button variant="outline" className="min-h-12" onClick={() => perform(refresh)} disabled={busy}>다시 확인</Button>}</div>}
          {notice && <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">{notice}</p>}
          {status?.verified && !enrollment && <div className="space-y-3"><p className="font-medium">{status.demo ? "데모에서는 추가 인증을 등록하지 않습니다." : "이 접속의 추가 인증이 완료되었습니다."}</p><Button asChild className="min-h-12 w-full text-base"><Link href="/admin" prefetch={false}>관리자 화면으로 이동</Link></Button></div>}
          {status?.verified && verifiedFactors.length > 0 && <p className="break-words text-sm text-muted-foreground">등록한 인증 앱: {verifiedFactors.map((factor) => factor.name).join(", ")}</p>}

          {enrollment && <section aria-labelledby="mfa-register-heading" className="space-y-3 rounded-md border p-4">
            <h2 id="mfa-register-heading" className="font-semibold">인증 앱에 추가하기</h2>
            <p>인증 앱에서 계정 추가를 선택하고 QR 코드를 스캔해 주세요.</p>
            {/* 인증 서버가 반환한 QR을 이미지로만 표시한다. SVG를 DOM에 삽입하지 않는다. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qrCode} alt="관리자 인증 앱 등록용 QR 코드. 스캔이 어려우면 아래 직접 입력 키를 사용하세요." className="mx-auto h-52 w-52 max-w-full rounded bg-white p-2" referrerPolicy="no-referrer" />
            <details><summary className="cursor-pointer py-3 font-medium">QR 대신 키 직접 입력하기</summary><p className="mt-2 break-all rounded bg-muted p-3 font-mono text-base select-all">{enrollment.secret}</p></details>
            <p className="text-sm text-muted-foreground">QR 코드와 키를 다른 사람에게 보내지 마세요. 등록 완료 후 이 화면에서는 다시 표시하지 않습니다.</p>
          </section>}

          {needsVerify && <form onSubmit={verify} className="space-y-4">
            {!enrollment && verifiedFactors.length > 1 && <div className="space-y-2"><Label htmlFor="mfa-factor" className="text-base">사용할 인증 앱</Label><select id="mfa-factor" className="min-h-12 w-full rounded-md border bg-background px-3 text-base" value={factorId} onChange={(event) => setFactorId(event.target.value)} disabled={busy}>{verifiedFactors.map((factor) => <option key={factor.id} value={factor.id}>{factor.name}</option>)}</select></div>}
            <div className="space-y-2"><Label htmlFor="mfa-code" className="text-base">인증번호 6자리</Label><Input ref={codeRef} id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="h-12 text-base tracking-widest" disabled={busy} aria-describedby="mfa-code-hint" /><p id="mfa-code-hint" className="text-sm text-muted-foreground">인증 앱에 현재 표시된 번호를 입력해 주세요.</p></div>
            <Button type="submit" className="min-h-12 w-full text-base" disabled={busy || code.length !== 6}>{busy ? "확인 중…" : enrollment ? "등록 완료하기" : "추가 인증하기"}</Button>
            {enrollment && <Button type="button" variant="outline" className="min-h-12 w-full" disabled={busy} onClick={() => cancel(enrollment.factorId)}>이번 등록 취소</Button>}
          </form>}

          {status && !status.demo && !enrollment && (verifiedFactors.length === 0 || status.verified) && verifiedFactors.length < 2 && <section className="space-y-3 border-t pt-4" aria-labelledby="mfa-add-heading">
            <h2 id="mfa-add-heading" className="font-semibold">{verifiedFactors.length ? "예비 인증 앱 등록" : "인증 앱 등록"}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{verifiedFactors.length ? "휴대전화를 잃어버려도 접속할 수 있도록, 별도로 보관하는 기기에 두 번째 인증 앱을 등록해 주세요." : "휴대전화의 인증 앱을 준비해 주세요. 등록을 시작한 뒤 QR 코드와 인증번호로 확인합니다."}</p>
            <Label htmlFor="mfa-name" className="text-base">구분할 이름</Label><Input id="mfa-name" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} className="h-12 text-base" disabled={busy} />
            <Button type="button" variant="outline" className="min-h-12 w-full" onClick={enroll} disabled={busy || !name.trim()}>등록 시작하기</Button>
          </section>}
          {!enrollment && pendingFactors.length > 0 && <section className="space-y-2 border-t pt-4" aria-label="미완료 인증 앱 등록"><p className="font-medium">미완료 등록</p><p className="text-sm text-muted-foreground">QR 코드가 있는 등록 화면을 닫았다면 해당 등록을 취소한 뒤 다시 시작해 주세요.</p>{pendingFactors.map((factor) => <div key={factor.id} className="flex items-center justify-between gap-3"><span className="break-all">{factor.name}</span><Button variant="outline" className="min-h-12 shrink-0" disabled={busy} onClick={() => cancel(factor.id)} aria-label={`${factor.name} 미완료 등록 취소`}>취소</Button></div>)}</section>}
          <details className="border-t pt-3"><summary className="cursor-pointer py-3 font-medium">인증 앱을 사용할 수 없나요?</summary><p className="text-sm leading-relaxed text-muted-foreground">예비 인증 앱이 있으면 위에서 선택해 인증하세요. 두 앱을 모두 사용할 수 없으면 서비스 운영 담당자에게 본인 확인과 인증 수단 초기화를 요청해 주세요.</p></details>
          <Button variant="ghost" asChild className="min-h-12 w-full"><Link href="/home">홈으로 돌아가기</Link></Button>
        </CardContent>
      </Card>
    </main>
  );
}
