import { loginAccessTrackingStartLabel } from "@/lib/login-access";
import { WEB_RELEASE_SUMMARY } from "@/lib/web-release";

type LoginAccessStatsProps = {
  today: number | null;
  total: number | null;
};

const countFormatter = new Intl.NumberFormat("ko-KR");
const trackingStartLabel = loginAccessTrackingStartLabel();
const webUpdatedAt = process.env.NEXT_PUBLIC_WEB_UPDATED_AT;
const webUpdatedDate = webUpdatedAt ? new Date(webUpdatedAt) : null;
const webUpdatedLabel = webUpdatedDate && Number.isFinite(webUpdatedDate.getTime())
  ? new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(webUpdatedDate).replace(/-/g, ".")
  : null;

function formatCount(value: number | null): string {
  return value === null ? "—" : countFormatter.format(value);
}

export function LoginAccessStats({ today, total }: LoginAccessStatsProps) {
  return (
    <section
      aria-labelledby="login-access-stats-title"
      aria-describedby="login-access-stats-note"
      className="mt-4 border border-slate-200 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/50"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="login-access-stats-title"
          className="text-xs font-bold text-slate-800 dark:text-slate-200"
        >
          시범운영 접속 현황
        </h2>
        <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
          {trackingStartLabel} 시작 · KST
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 divide-x divide-slate-200 dark:divide-slate-700">
        <div className="pr-4">
          <dt className="text-xs font-medium text-muted-foreground">
            오늘 접속
          </dt>
          <dd className="mt-0.5 tabular-nums text-lg font-black text-slate-950 dark:text-slate-50">
            {formatCount(today)}
            {today !== null ? (
              <span className="ml-1 text-xs font-semibold text-muted-foreground">
                회
              </span>
            ) : null}
          </dd>
        </div>
        <div className="pl-4">
          <dt className="text-xs font-medium text-muted-foreground">
            시범운영 누적
          </dt>
          <dd className="mt-0.5 tabular-nums text-lg font-black text-slate-950 dark:text-slate-50">
            {formatCount(total)}
            {total !== null ? (
              <span className="ml-1 text-xs font-semibold text-muted-foreground">
                회
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <p id="login-access-stats-note" className="sr-only">
        로그인 세션을 KST 날짜별로 한 번 집계하며, 실제 이용 인원과 다를 수
        있습니다.
      </p>
    </section>
  );
}

export function SidebarAccessStats({ today, total }: LoginAccessStatsProps) {
  return (
    <section
      aria-labelledby="sidebar-access-stats-title"
      aria-describedby="sidebar-access-stats-note"
      className="sidebar-access-stats mb-2 border border-slate-700 bg-ops-navy-deep px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="sidebar-access-stats-title"
          className="text-xs font-semibold text-slate-200"
        >
          접속 현황
        </h2>
        <span className="sidebar-access-stats-date whitespace-nowrap text-xs text-slate-400">
          {trackingStartLabel} 시작
        </span>
      </div>

      <dl className="sidebar-access-stats-values mt-1.5 grid grid-cols-2 divide-x divide-slate-700">
        <div className="flex items-baseline justify-between gap-1 pr-2">
          <dt className="text-xs text-slate-400">오늘</dt>
          <dd className="tabular-nums text-base font-bold text-white">
            {formatCount(today)}
            {today !== null ? (
              <span className="ml-0.5 text-xs font-medium text-slate-400">
                회
              </span>
            ) : null}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-1 pl-2">
          <dt className="text-xs text-slate-400">누적</dt>
          <dd className="tabular-nums text-base font-bold text-white">
            {formatCount(total)}
            {total !== null ? (
              <span className="ml-0.5 text-xs font-medium text-slate-400">
                회
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {webUpdatedLabel && (
        <div className="mt-2 min-w-0 border-t border-slate-700/70 pt-1.5 text-[11px] leading-4 text-slate-400">
          <p className="tabular-nums whitespace-nowrap">
            최종 수정 · <time dateTime={webUpdatedAt} title="웹 버전 갱신 시각 · 한국시간(KST)">{webUpdatedLabel}</time>
          </p>
          <p className="mt-0.5 truncate" title={WEB_RELEASE_SUMMARY}>
            <span className="sr-only">수정 내역: </span>
            {WEB_RELEASE_SUMMARY}
          </p>
        </div>
      )}

      <p id="sidebar-access-stats-note" className="sr-only">
        KST 기준 로그인 세션 접속 횟수입니다.
        {today === null || total === null
          ? " 집계 정보를 불러오지 못했습니다."
          : ""}
      </p>
    </section>
  );
}
