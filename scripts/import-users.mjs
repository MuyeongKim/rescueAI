// 대원 명단 일괄 계정 등록 스크립트 (관리자용, 서버에서만 실행)
//
// 사용법:
//   1) 엑셀 명단을 "CSV(UTF-8)"로 저장 — 열 순서(헤더 행 있으면 자동 건너뜀):
//      email, full_name, division, rank, team, digital_id, role(선택: admin|user)
//      예) kim@jbfire.go.kr,김구조,전주소방서,소방교,구조1팀,12345678,user
//   2) node scripts/import-users.mjs <명단.csv> [--random-password]
//
// 동작: Supabase Auth 계정 생성 → profiles에 이름·소속·계급·팀·디지털식별번호·권한 반영.
//       이미 있는 계정은 비밀번호는 유지하고 프로필만 갱신한다.
//       모든 신규 계정은 must_change_password=true 로 표시돼 첫 로그인 시 변경을 강제하고,
//       변경 전에는 페이지뿐 아니라 API 도 막힌다(lib/auth.ts requireApiUser).
//
// 초기 비밀번호 두 가지 모드:
//   (기본) 디지털식별번호(digital_id)  — 배포가 필요 없어 간편하지만, 명단을 아는 사람은
//          비번을 아는 셈이다. 반드시 첫 로그인 즉시 변경시킬 것.
//   (--random-password) 계정마다 무작위 비번을 만들고 `<명단>.passwords.csv` 로 떨궈
//          관리자가 개별 전달한다. 명단 유출만으로는 로그인할 수 없어 더 안전하다.
//
// ⚠️ profiles.digital_id 는 "직원 식별번호"로 저장되는 값이다. 기본 모드에서는 이 값이 곧
//    초기 비밀번호이므로 비밀로 취급할 수 없다 — 민감하게 다뤄야 하면 --random-password 를 쓸 것.
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// .env.local 로드 (dotenv 의존 없이 단순 파싱). 주석·따옴표·export 접두를 처리한다.
function loadEnv() {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[1] in process.env) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || url.includes("demo.supabase")) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local에 필요합니다.");
  process.exit(1);
}

const args = process.argv.slice(2);
const randomPassword = args.includes("--random-password");
const csvPath = args.find((a) => !a.startsWith("--"));
if (!csvPath || !existsSync(csvPath)) {
  console.error("사용법: node scripts/import-users.mjs <명단.csv> [--random-password]");
  process.exit(1);
}

// 사람이 옮겨 적기 쉬운 무작위 비번(혼동 문자 0/O/1/l/I 제외, 12자)
const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generatePassword(length = 12) {
  let out = "";
  for (let i = 0; i < length; i++) out += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return out;
}

// 간단 CSV 파서 (따옴표 필드 지원)
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = parseCsv(readFileSync(csvPath, "utf-8"));
// 헤더 행(email, ...)이 있으면 건너뜀
if (rows.length && /email/i.test(rows[0][0])) rows.shift();

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let created = 0, updated = 0, skipped = 0, failed = 0;
const issued = []; // --random-password 모드에서 배포할 초기 비번

for (const [email, fullName, division, rank, team, digitalId, role] of rows) {
  if (!email || !email.includes("@")) {
    console.warn(`건너뜀(이메일 형식 아님): ${email ?? "(빈 행)"}`);
    skipped++;
    continue;
  }
  const safeRole = role === "admin" ? "admin" : "user";
  const staffId = (digitalId || "").trim();

  // 초기 비밀번호: 무작위(권장) 또는 디지털식별번호(Supabase 최소 6자)
  const password = randomPassword ? generatePassword() : staffId;
  if (!randomPassword && password.length < 6) {
    console.warn(`건너뜀(디지털식별번호 6자 미만 → 비번 불가): ${email} (${password || "빈값"})`);
    skipped++;
    continue;
  }

  // 1) Auth 계정 생성 (이미 있으면 기존 id 조회 — 비번은 유지)
  let userId = null;
  const { data: createdUser, error: createErr } =
    await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || null },
    });

  if (createErr) {
    if (/already.*(registered|exists)/i.test(createErr.message)) {
      const { data: profile } = await supabase
        .from("profiles").select("id").eq("email", email).maybeSingle();
      if (!profile) {
        console.error(`실패(기존 계정 id 조회 불가): ${email}`);
        failed++;
        continue;
      }
      userId = profile.id;
    } else {
      console.error(`실패(${email}): ${createErr.message}`);
      failed++;
      continue;
    }
  } else {
    userId = createdUser.user.id;
    created++;
    if (randomPassword) issued.push({ email, fullName: fullName || "", password });
  }

  // 2) profiles에 이름·소속·권한 반영 (트리거가 만든 행을 갱신)
  //    기존 계정은 must_change_password 를 건드리지 않는다 — 이미 비번을 바꾼 대원을
  //    명단 재적용만으로 다시 변경 화면에 가두면 안 된다.
  const patch = {
    full_name: fullName || null,
    division: division || null,
    rank: rank || null,
    team: team || null,
    digital_id: staffId || null,
    role: safeRole,
  };
  if (!createErr) patch.must_change_password = true; // 신규 계정만 첫 로그인 변경 강제

  const { error: profErr } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (profErr) {
    console.error(`프로필 갱신 실패(${email}): ${profErr.message}`);
    failed++;
  } else if (!createErr) {
    console.log(`생성: ${email} (${fullName ?? "-"} / ${division ?? "-"} / ${safeRole})`);
  } else {
    console.log(`갱신: ${email} (기존 계정 — 프로필만 반영)`);
    updated++;
  }
}

if (issued.length > 0) {
  const outPath = `${csvPath}.passwords.csv`;
  writeFileSync(
    outPath,
    ["email,full_name,initial_password"]
      .concat(issued.map((r) => [r.email, r.fullName, r.password].map(csvEscape).join(",")))
      .join("\n") + "\n",
    { mode: 0o600 }
  );
  console.log(`\n초기 비밀번호 ${issued.length}건 → ${outPath}`);
  console.log("   개별 전달 후 이 파일은 반드시 삭제하세요(평문 비밀번호).");
}

console.log(`\n완료 — 생성 ${created} · 기존 갱신 ${updated} · 건너뜀 ${skipped} · 실패 ${failed}`);
if (!randomPassword) {
  console.log(
    "ℹ️  초기 비밀번호 = 디지털식별번호입니다. 명단을 아는 사람은 비번도 아는 셈이니\n" +
      "   첫 로그인 변경을 반드시 확인하세요. 더 안전하게 하려면 --random-password 를 쓰세요."
  );
}
