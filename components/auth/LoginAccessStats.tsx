type LoginAccessStatsProps = {
  today: number | null;
  total: number | null;
};

const countFormatter = new Intl.NumberFormat("ko-KR");

function formatCount(value: number | null): string {
  return value === null ? "—" : countFormatter.format(value);
}

export function LoginAccessStats({ today, total }: LoginAccessStatsProps) {
  return (
    <section
      aria-labelledby="login-access-stats-title"
      className="mt-5 border border-slate-200 bg-slate-50/80 px-4 py-3.5 dark:border-slate-800 dark:bg-slate-900/50"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="login-access-stats-title"
          className="text-sm font-bold text-slate-800 dark:text-slate-200"
        >
          시범운영 접속 현황
        </h2>
        <span className="text-xs font-semibold text-muted-foreground">
          KST 기준
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 divide-x divide-slate-200 dark:divide-slate-700">
        <div className="pr-4">
          <dt className="text-xs font-medium text-muted-foreground">
            오늘 접속
          </dt>
          <dd className="mt-1 tabular-nums text-xl font-black text-slate-950 dark:text-slate-50">
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
          <dd className="mt-1 tabular-nums text-xl font-black text-slate-950 dark:text-slate-50">
            {formatCount(total)}
            {total !== null ? (
              <span className="ml-1 text-xs font-semibold text-muted-foreground">
                회
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-muted-foreground dark:border-slate-800">
        로그인 후 서비스 화면에 들어온 브라우저를 하루 한 번 집계하며, 실제
        인원수와 다를 수 있습니다.
      </p>
    </section>
  );
}
