import { Suspense } from "react";
import Image from "next/image";
import {
  Flame,
  HeartPulse,
  Loader2,
  Mountain,
  Waves,
} from "lucide-react";

import { LoginAccessStats } from "@/components/auth/LoginAccessStats";
import { getLoginAccessStats } from "@/lib/login-access-stats";

import LoginForm from "./login-form";

async function LoginAccessStatsFromServer() {
  const stats = await getLoginAccessStats();
  return <LoginAccessStats today={stats.today} total={stats.total} />;
}

function LoginStatsFallback() {
  return <LoginAccessStats today={null} total={null} />;
}

function LoginHero() {
  return (
    <section className="login-hero command-grid relative flex min-h-[152px] flex-col overflow-hidden bg-ops-navy px-5 py-4 text-white sm:min-h-[220px] sm:px-8 sm:py-6 md:min-h-dvh md:px-12 md:py-12 lg:px-16">
      <div
        className="hazard-stripe absolute inset-x-0 top-0 h-1.5 text-ops-signal"
        aria-hidden
      />
      <div
        className="command-scan-line pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-ops-signal-bright shadow-[0_0_18px_2px_rgba(240,84,45,0.45)]"
        aria-hidden
      />

      <div
        className="pointer-events-none absolute -right-32 top-[20%] h-[420px] w-[420px] rounded-full border border-ops-signal/25 md:-right-24 md:top-[26%]"
        aria-hidden
      >
        <span className="absolute inset-[72px] rounded-full border border-ops-signal/20" />
        <span className="absolute inset-[145px] rounded-full border border-ops-signal/20" />
        <span className="command-radar-sweep absolute left-1/2 top-1/2 h-px w-1/2 origin-left -translate-y-1/2 bg-ops-signal/60" />
        <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ops-signal-bright shadow-[0_0_18px_5px_rgba(240,84,45,0.35)]" />
      </div>

      <div
        className="anim-rise relative z-10 flex items-center gap-3"
        style={{ animationDelay: "0.05s" }}
      >
        <span className="flex h-9 w-20 items-center justify-center bg-white px-2 sm:h-12 sm:w-[88px]">
          <Image
            src="/logo-jbfire.png"
            alt="전북소방 엠블럼"
            width={76}
            height={38}
            className="h-auto max-h-full w-auto"
            priority
          />
        </span>
        <div>
          <p className="text-xs text-slate-400">전북특별자치도 소방본부</p>
          <p className="mt-0.5 text-sm font-bold text-white">
            전북소방 구조 AI
          </p>
        </div>
      </div>

      <div className="login-hero-copy relative z-10 mt-auto max-w-xl pb-1 pt-2 sm:pt-6 md:my-auto md:py-14">
        <p
          className="anim-rise hidden text-xs font-bold text-ops-signal-soft sm:block"
          style={{ animationDelay: "0.12s" }}
        >
          구조 대응 준비 시스템
        </p>
        <h1
          className="anim-rise mt-0 text-[23px] font-black leading-[1.2] text-white sm:mt-3 sm:text-3xl md:mt-4 md:text-4xl lg:text-[44px]"
          style={{ animationDelay: "0.2s" }}
        >
          현장을 준비하는
          <br />
          구조대원의 훈련 플랫폼
        </h1>
        <p
          className="login-hero-detail anim-rise mt-5 hidden max-w-md text-sm leading-7 text-slate-300 md:block md:text-base"
          style={{ animationDelay: "0.28s" }}
        >
          구조 매뉴얼의 근거를 확인하고 훈련에 필요한 자료를 신속하게
          준비합니다.
        </p>

        <div
          className="login-hero-detail anim-rise mt-7 hidden grid-cols-2 gap-2 sm:grid-cols-4 md:grid"
          style={{ animationDelay: "0.36s" }}
          aria-label="구조 교육 분야"
        >
          {[
            { label: "산악 구조", icon: Mountain, color: "text-emerald-400" },
            { label: "수난 구조", icon: Waves, color: "text-sky-400" },
            { label: "화재 대응", icon: Flame, color: "text-orange-400" },
            { label: "응급 구조", icon: HeartPulse, color: "text-rose-400" },
          ].map(({ label, icon: Icon, color }) => (
            <span
              key={label}
              className="flex min-h-11 items-center gap-2 border border-slate-600 bg-ops-panel px-3 text-xs font-semibold text-slate-200"
            >
              <Icon className={`h-4 w-4 ${color}`} aria-hidden />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="login-hero-footer relative z-10 hidden items-end justify-between border-t border-slate-700 pt-5 text-[11px] text-slate-400 md:flex">
        <p>
          인덱싱된 교육자료에 근거해 답하고
          <br />
          확인되지 않은 내용은 추측하지 않습니다.
        </p>
        <p className="text-right">
          RESCUE AI / JB-119
          <br />
          AUTHORIZED ACCESS
        </p>
      </div>
    </section>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-dvh md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(420px,0.8fr)]">
      <LoginHero />
      <section className="login-panel relative flex min-h-[calc(100dvh-152px)] items-center justify-center bg-background px-5 py-6 sm:min-h-[calc(100dvh-220px)] sm:px-8 sm:py-8 md:min-h-dvh md:px-10 md:py-10">
        <div
          className="absolute inset-y-0 left-0 hidden w-1 bg-primary md:block"
          aria-hidden
        />
        <div className="w-full max-w-md">
          <Suspense
            fallback={
              <div className="flex min-h-52 items-center justify-center gap-2 text-muted-foreground">
                <Loader2
                  className="h-5 w-5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                불러오는 중…
              </div>
            }
          >
            <LoginForm />
          </Suspense>

          <Suspense fallback={<LoginStatsFallback />}>
            <LoginAccessStatsFromServer />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
