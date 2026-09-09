// 관리자 전용 CSV 계정 발급. 기존 계정의 비밀번호·프로필·권한은 변경하지 않는다.
// node scripts/import-users.mjs <명단.csv> [--password-file <출력.passwords.csv>]
// 열: email,full_name,division,rank,team,digital_id,role(admin|user)
// 모든 초기 비밀번호는 무작위다. --random-password는 기존 명령 호환용으로만 허용한다.
// 계정 상태 마이그레이션을 먼저 적용한다. Auth 생성부터 완료까지 account_ready=false이고,
// 프로필 설정·비밀번호 파일 기록이 성공한 뒤에만 마지막 DB 요청으로 이용 준비를 완료한다.
import { randomInt, randomBytes } from "node:crypto";
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertDatabaseEnvironment } from "./lib/database-environment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BLOCK_DURATION = "876000h";

export function generatePassword(length = 20) {
  let result = "";
  for (let i = 0; i < length; i++) result += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return result;
}

export function loadImportEnvironment(env = process.env, io = { existsSync, readFileSync }) {
  const checkDevelopment = () => {
    const registry = JSON.parse(io.readFileSync(join(root, "config/database-environments.json"), "utf8"));
    // 명시적인 개발 발급에서는 셸에 남은 Vercel 운영 표식으로 경계를 우회하지 않는다.
    assertDatabaseEnvironment({ ...env, VERCEL_ENV: "development" }, registry);
  };
  if (env.RESCUEAI_DATABASE_ENV === "development") {
    checkDevelopment();
    return; // 개발 파일에 빠진 키를 운영 .env.local에서 보충하지 않는다.
  }
  const path = join(root, ".env.local");
  if (!io.existsSync(path)) return;
  for (const line of io.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in env) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  if (env.RESCUEAI_DATABASE_ENV === "development") checkDevelopment();
}

export function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let current = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') quoted = false;
        else current += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(current); current = ""; }
      else current += ch;
    }
    if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다.");
    cells.push(current);
    rows.push(cells.map(cell => cell.trim()));
  }
  if (rows.length && /^email$/i.test(rows[0][0])) rows.shift();
  return rows;
}

function csvEscape(value) {
  let text = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createCredentialWriter(path) {
  // 기존 파일·심볼릭 링크를 덮어쓰지 않는다. 소유자만 읽을 수 있게 생성한다.
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, "email,full_name,initial_password\n"); fsyncSync(fd); }
  catch (error) { closeSync(fd); throw error; }
  return {
    append({ email, fullName, password }) {
      writeSync(fd, [email, fullName, password].map(csvEscape).join(",") + "\n");
      fsyncSync(fd);
    },
    close() { closeSync(fd); },
  };
}

function alreadyExists(error) {
  return ["email_exists", "user_already_exists"].includes(error?.code)
    || /already.*(registered|exists)/i.test(error?.message ?? "");
}

export async function importUsers({ supabase, rows, writeCredential, log = console.log, warn = console.error }) {
  const counts = { created: 0, existing: 0, skipped: 0, failed: 0, cleanupFailed: 0 };
  const schema = await supabase.from("profiles").select("account_ready,must_change_password").limit(0);
  if (schema.error) throw new Error("계정 보완 마이그레이션을 먼저 적용해 주세요.");

  for (const [email, fullName, division, rank, team, digitalId, role] of rows) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      counts.skipped++;
      warn("건너뜀: 이메일 형식이 올바르지 않은 행");
      continue;
    }
    let userId;
    try {
      const password = generatePassword();
      const created = await supabase.auth.admin.createUser({
        email, password, email_confirm: true, ban_duration: BLOCK_DURATION,
        user_metadata: { full_name: fullName || null },
      });
      if (created.error) {
        if (alreadyExists(created.error)) {
          counts.existing++;
          log(`건너뜀: ${email} (기존 계정의 비밀번호·프로필·권한 유지)`);
          continue;
        }
        throw new Error("계정 생성 실패");
      }
      userId = created.data?.user?.id;
      if (!userId) throw new Error("생성 계정 확인 실패");

      const initialized = await supabase.from("profiles").update({
        full_name: fullName || null, division: division || null, rank: rank || null,
        team: team || null, digital_id: digitalId || null, role: role === "admin" ? "admin" : "user",
        must_change_password: true, account_ready: false,
      }).eq("id", userId).select("id,account_ready,must_change_password").single();
      if (initialized.error || initialized.data?.id !== userId
          || initialized.data.account_ready !== false || initialized.data.must_change_password !== true) {
        throw new Error("프로필 초기 설정 실패");
      }

      const unblocked = await supabase.auth.admin.updateUserById(userId, { ban_duration: "none" });
      if (unblocked.error || unblocked.data?.user?.id !== userId) throw new Error("계정 잠금 해제 실패");
      // 이 시점에도 account_ready=false. 파일 기록 실패·삭제 실패가 겹쳐도 업무 접근 불가.
      writeCredential({ email, fullName: fullName || "", password });
      const ready = await supabase.from("profiles").update({ account_ready: true })
        .eq("id", userId).eq("account_ready", false).eq("must_change_password", true)
        .select("id,account_ready,must_change_password").single();
      if (ready.error || ready.data?.id !== userId
          || ready.data.account_ready !== true || ready.data.must_change_password !== true) {
        throw new Error("발급 완료 확인 실패");
      }
      counts.created++;
      log(`생성: ${email} (최초 비밀번호 변경 필요)`);
    } catch {
      counts.failed++;
      // SDK 오류 메시지는 비밀번호·요청값을 포함할 수 있으므로 기록하지 않는다.
      warn(`실패: ${email} (완료되지 않은 계정은 전달하지 마세요)`);
      if (userId) {
        // 현재 실행에서 새로 만든 계정에만 적용한다. 기존 계정은 건드리지 않는다.
        try { await supabase.from("profiles").update({ account_ready: false }).eq("id", userId); } catch { /* 생성 기본값도 false */ }
        let deleted = false;
        try { deleted = !(await supabase.auth.admin.deleteUser(userId)).error; } catch { /* 별도 잠금 재시도 */ }
        if (!deleted) {
          counts.cleanupFailed++;
          try { await supabase.auth.admin.updateUserById(userId, { ban_duration: BLOCK_DURATION }); } catch { /* 미완성 profile은 DB에서 차단 */ }
          warn(`정리 확인 필요: ${email} (새 계정 삭제 실패, 이용 준비 차단 상태 확인 필요)`);
        }
      }
    }
  }
  return counts;
}

export async function main(args = process.argv.slice(2)) {
  loadImportEnvironment();
  const outputFlag = args.indexOf("--password-file");
  const outputArg = outputFlag >= 0 ? args[outputFlag + 1] : undefined;
  const csvPath = args.find((arg, index) => !arg.startsWith("--") && (outputFlag < 0 || index !== outputFlag + 1));
  const unknown = args.filter(arg => arg.startsWith("--") && !["--password-file", "--random-password"].includes(arg));
  if (!csvPath || !existsSync(csvPath) || unknown.length || (outputFlag >= 0 && (!outputArg || outputArg.startsWith("--")))) {
    throw new Error("사용법: node scripts/import-users.mjs <명단.csv> [--password-file <출력.passwords.csv>]");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || url.includes("demo.supabase")) throw new Error("서버 전용 Supabase 환경 설정이 필요합니다.");
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const outputPath = outputArg ?? `${csvPath}.${Date.now()}-${randomBytes(4).toString("hex")}.passwords.csv`;
  if (!outputPath.endsWith(".passwords.csv")) throw new Error("비밀번호 출력 파일 이름은 .passwords.csv로 끝나야 합니다.");
  const writer = createCredentialWriter(outputPath);
  try {
    const counts = await importUsers({
      supabase: createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }),
      rows, writeCredential: row => writer.append(row),
    });
    console.log(`완료 — 생성 ${counts.created} · 기존 유지 ${counts.existing} · 건너뜀 ${counts.skipped} · 실패 ${counts.failed}`);
    console.log(`초기 비밀번호 파일: ${outputPath}`);
    console.log("생성 완료 계정만 개별 전달하고 파일을 삭제하세요. 실패 계정의 행이 포함될 수 있습니다.");
    if (counts.failed) process.exitCode = 1;
    return counts;
  } finally { writer.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("발급을 중단했습니다. CSV·출력 경로·서버 환경과 계정 보완 마이그레이션 적용 여부를 확인하세요.");
    process.exitCode = 1;
  });
}
