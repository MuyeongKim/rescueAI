import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createCredentialWriter, importUsers, loadImportEnvironment, parseCsv } from "../scripts/import-users.mjs";

type Profile = { id: string; account_ready: boolean; must_change_password: boolean; role?: string; full_name?: string | null };
type Failure = "schema" | "profile" | "missing-profile" | "unban" | "ready";
function fake(options: { failure?: Failure; cleanupFails?: boolean; existing?: boolean } = {}) {
  let profile: Profile | null = options.existing ? { id: "existing", account_ready: true, must_change_password: false, role: "user", full_name: "기존 이름" } : null;
  let banned = false;
  let deleted = false;
  let createdPassword = "";
  const events: string[] = [];
  const sensitiveError = { message: "synthetic-sensitive-password 12345678", code: "synthetic" };
  const admin = {
    createUser: vi.fn(async (input: { password: string; ban_duration: string }) => {
      events.push("auth-created");
      if (options.existing) return { data: null, error: { code: "email_exists" } };
      createdPassword = input.password;
      banned = input.ban_duration !== "none";
      profile = { id: "new", account_ready: false, must_change_password: true };
      return { data: { user: { id: "new" } }, error: null };
    }),
    updateUserById: vi.fn(async (_id: string, patch: { ban_duration: string }) => {
      events.push(patch.ban_duration === "none" ? "auth-unbanned" : "auth-rebanned");
      if (options.failure === "unban" || (options.cleanupFails && patch.ban_duration !== "none")) return { data: null, error: sensitiveError };
      banned = patch.ban_duration !== "none";
      return { data: { user: { id: "new" } }, error: null };
    }),
    deleteUser: vi.fn(async () => {
      events.push("auth-delete");
      if (options.cleanupFails) return { error: sensitiveError };
      deleted = true; profile = null;
      return { error: null };
    }),
  };
  const from = vi.fn(() => {
    let patch: Partial<Profile> | undefined;
    const result = () => {
      if (patch) {
        if ("full_name" in patch) {
          events.push("profile-initialized");
          if (options.failure === "profile") return { data: null, error: sensitiveError };
          if (options.failure === "missing-profile") return { data: null, error: null };
        } else if (patch.account_ready === true) {
          events.push("profile-ready");
          if (options.failure === "ready") return { data: null, error: sensitiveError };
        } else {
          events.push("profile-blocked");
          if (options.cleanupFails) return { data: null, error: sensitiveError };
        }
        if (profile) profile = { ...profile, ...patch };
      }
      return { data: profile, error: null };
    };
    const query = {
      update(value: Partial<Profile>) { patch = value; return query; },
      eq() { return query; },
      select() { return query; },
      async limit() { return { data: [], error: options.failure === "schema" ? sensitiveError : null }; },
      async single() { return result(); },
      then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
    };
    return query;
  });
  return { supabase: { auth: { admin }, from }, events, state: () => ({ profile, banned, deleted, createdPassword }) };
}
const rows = [["new@example.invalid", "합성 계정", "시험부서", "시험계급", "시험팀", "12345678", "user"]];
async function run(client: ReturnType<typeof fake>, failWrite = false) {
  const logs: string[] = [];
  const credentials: { email: string; fullName: string; password: string }[] = [];
  const counts = await importUsers({
    supabase: client.supabase, rows,
    writeCredential: (row: { email: string; fullName: string; password: string }) => {
      client.events.push("credentials-persisted");
      expect(client.state().profile?.account_ready).toBe(false);
      if (failWrite) throw new Error("synthetic file error");
      credentials.push(row);
    },
    log: (line: string) => logs.push(line), warn: (line: string) => logs.push(line),
  });
  expect(logs.join("\n")).not.toContain("synthetic-sensitive-password");
  expect(logs.join("\n")).not.toContain("12345678");
  if (client.state().createdPassword) expect(logs.join("\n")).not.toContain(client.state().createdPassword);
  return { counts, credentials };
}

describe("일괄 계정 발급의 실패 차단", () => {
  it("직원번호와 무관한 임시 비밀번호를 기록한 뒤에만 신규 계정의 발급을 완료한다", async () => {
    const client = fake();
    const { counts, credentials } = await run(client);
    expect(counts).toEqual({ created: 1, existing: 0, skipped: 0, failed: 0, cleanupFailed: 0 });
    expect(credentials[0].password).toHaveLength(20);
    expect(credentials[0].password).not.toBe("12345678");
    expect(client.events).toEqual(["auth-created", "profile-initialized", "auth-unbanned", "credentials-persisted", "profile-ready"]);
    expect(client.state()).toMatchObject({ banned: false, deleted: false, profile: { account_ready: true, must_change_password: true } });
  });
  it("재실행은 기존 계정의 프로필·역할·비밀번호·세션 상태를 수정하지 않는다", async () => {
    const client = fake({ existing: true }); const before = client.state();
    const { counts, credentials } = await run(client);
    expect(counts.existing).toBe(1); expect(credentials).toEqual([]); expect(client.state()).toEqual(before);
    expect(client.supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(client.supabase.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(client.supabase.from).toHaveBeenCalledTimes(1); // 무부작용 스키마 확인만 수행
  });
  it.each(["profile", "missing-profile", "unban", "ready"] as const)("%s 실패 시 성공으로 보고하지 않고 신규 계정을 정리한다", async failure => {
    const client = fake({ failure }); const { counts } = await run(client);
    expect(counts.created).toBe(0); expect(counts.failed).toBe(1); expect(client.state().deleted).toBe(true);
  });
  it("프로필 설정·차단 재요청·Auth 삭제가 모두 실패해도 생성 시 차단 상태를 유지한다", async () => {
    const client = fake({ failure: "profile", cleanupFails: true }); const { counts, credentials } = await run(client);
    expect(counts).toMatchObject({ created: 0, failed: 1, cleanupFailed: 1 });
    expect(client.state()).toMatchObject({ deleted: false, banned: true, profile: { account_ready: false, must_change_password: true } });
    expect(credentials).toEqual([]);
  });
  it("비밀번호 파일 저장이 실패하면 이용 준비 상태를 열지 않는다", async () => {
    const client = fake(); const { counts } = await run(client, true);
    expect(counts.failed).toBe(1); expect(client.events).not.toContain("profile-ready"); expect(client.state().deleted).toBe(true);
  });
  it.each(["ready", "file"] as const)("%s 후속 실패에 삭제·재차단 실패가 겹쳐도 account_ready=false를 유지한다", async stage => {
    const client = fake({ failure: stage === "ready" ? "ready" : undefined, cleanupFails: true });
    const { counts } = await run(client, stage === "file");
    expect(counts).toMatchObject({ created: 0, failed: 1, cleanupFailed: 1 });
    expect(client.state()).toMatchObject({ deleted: false, banned: false, profile: { account_ready: false, must_change_password: true } });
  });
  it("필수 DB 마이그레이션 누락은 계정을 만들기 전에 중단한다", async () => {
    const client = fake({ failure: "schema" });
    await expect(run(client)).rejects.toThrow(/마이그레이션/);
    expect(client.supabase.auth.admin.createUser).not.toHaveBeenCalled();
  });
});

describe("발급 비밀번호 파일", () => {
  it("새 파일은 0600이며 기존 파일과 심볼릭 링크를 덮어쓰지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "rescue-import-test-"));
    try {
      const path = join(dir, "issued.passwords.csv");
      const writer = createCredentialWriter(path);
      writer.append({ email: "synthetic@example.invalid", fullName: "=SYNTHETIC()", password: "synthetic-password-only" });
      writer.close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toContain("'=SYNTHETIC()");
      expect(() => createCredentialWriter(path)).toThrow();
      const target = join(dir, "target.txt"); writeFileSync(target, "unchanged", { mode: 0o644 });
      const link = join(dir, "linked.passwords.csv"); symlinkSync(target, link);
      expect(() => createCredentialWriter(link)).toThrow(); expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("BOM·따옴표 CSV를 처리하고 직원번호가 비어 있어도 임시 비밀번호 발급에 사용하지 않는다", async () => {
    expect(parseCsv('\uFEFFemail,full_name\nnew@example.invalid,"이름,합성"\n')).toEqual([["new@example.invalid", "이름,합성"]]);
    const client = fake();
    const result = await importUsers({ supabase: client.supabase, rows: [["new@example.invalid", "합성"]], writeCredential: vi.fn(), log: vi.fn(), warn: vi.fn() });
    expect(result.created).toBe(1); expect(client.state().createdPassword).toHaveLength(20);
  });
});

describe("계정 발급의 개발·운영 환경 경계", () => {
  function envFiles() {
    return {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((path: string) => path.endsWith("database-environments.json")
        ? JSON.stringify({ productionProjectRefs: ["productiontest"], developmentProjectRefs: ["developmenttest"] })
        : "NEXT_PUBLIC_SUPABASE_URL=https://productiontest.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=synthetic-production-only\n"),
    };
  }
  it("개발 발급에서 빠진 서버 키를 운영 .env.local에서 읽어 채우지 않는다", () => {
    const env: Record<string, string> = { RESCUEAI_DATABASE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://developmenttest.supabase.co" };
    const io = envFiles(); loadImportEnvironment(env, io);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(io.existsSync).not.toHaveBeenCalled();
    expect(io.readFileSync.mock.calls.map(call => call[0])).toEqual([expect.stringContaining("config/database-environments.json")]);
  });
  it.each([undefined, "production"])("개발 발급의 운영 URL은 VERCEL_ENV=%s에서도 계정 생성 전에 거절한다", vercel => {
    const env: Record<string, string> = { RESCUEAI_DATABASE_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://productiontest.supabase.co" };
    if (vercel) env.VERCEL_ENV = vercel;
    const io = envFiles(); expect(() => loadImportEnvironment(env, io)).toThrow(/운영 DB 연결을 차단/);
    expect(io.existsSync).not.toHaveBeenCalled();
  });
  it.each([undefined, "https://unregisteredtest.supabase.co"])("설정 누락·미등록 개발 URL은 운영 파일로 폴백하지 않는다: %s", url => {
    const env: Record<string, string> = { RESCUEAI_DATABASE_ENV: "development" };
    if (url) env.NEXT_PUBLIC_SUPABASE_URL = url;
    const io = envFiles(); expect(() => loadImportEnvironment(env, io)).toThrow(/개발 DB/);
    expect(io.existsSync).not.toHaveBeenCalled();
  });
  it("기존 운영 발급 방식은 .env.local을 읽고 명시적 환경값을 덮어쓰지 않는다", () => {
    const env: Record<string, string> = { SUPABASE_SERVICE_ROLE_KEY: "synthetic-explicit-only" };
    const io = envFiles(); loadImportEnvironment(env, io);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://productiontest.supabase.co");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("synthetic-explicit-only");
    expect(io.readFileSync).toHaveBeenCalledTimes(1);
    expect(io.readFileSync.mock.calls[0][0]).toMatch(/\.env\.local$/);
  });
});
