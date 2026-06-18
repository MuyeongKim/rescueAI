// 대원 명단 일괄 계정 등록 스크립트 (관리자용, 서버에서만 실행)
//
// 사용법:
//   1) 엑셀 명단을 "CSV(UTF-8)"로 저장 — 열 순서(헤더 행 있으면 자동 건너뜀):
//      email, full_name, division, rank, team, digital_id, role(선택: admin|user)
//      예) kim@jbfire.go.kr,김구조,전주소방서,소방교,구조1팀,12345678,user
//   2) node scripts/import-users.mjs <명단.csv>
//
// 동작: Supabase Auth 계정 생성 → profiles에 이름·소속·계급·팀·디지털식별번호·권한 반영.
//       이미 있는 계정은 비밀번호는 유지하고 프로필만 갱신한다.
// 초기 비밀번호 = 디지털식별번호(digital_id), 이메일 확인 완료 처리. 첫 로그인 후 변경 권장.
//   (Supabase 최소 비번 길이 6자 — digital_id 가 6자 미만이면 해당 행은 실패로 표시된다.)
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// .env.local 로드 (dotenv 의존 없이 단순 파싱)
function loadEnv() {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || url.includes("demo.supabase")) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local에 필요합니다.");
  process.exit(1);
}

const csvPath = process.argv[2];
if (!csvPath || !existsSync(csvPath)) {
  console.error("사용법: node scripts/import-users.mjs <명단.csv>");
  process.exit(1);
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

const rows = parseCsv(readFileSync(csvPath, "utf-8"));
// 헤더 행(email, ...)이 있으면 건너뜀
if (rows.length && /email/i.test(rows[0][0])) rows.shift();

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let created = 0, updated = 0, skipped = 0, failed = 0;

for (const [email, fullName, division, rank, team, digitalId, role] of rows) {
  if (!email || !email.includes("@")) {
    console.warn(`건너뜀(이메일 형식 아님): ${email ?? "(빈 행)"}`);
    skipped++;
    continue;
  }
  const safeRole = role === "admin" ? "admin" : "user";

  // 초기 비밀번호 = 디지털식별번호 (Supabase 최소 6자)
  const password = (digitalId || "").trim();
  if (password.length < 6) {
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
  }

  // 2) profiles에 이름·소속·권한 반영 (트리거가 만든 행을 갱신)
  const { error: profErr } = await supabase
    .from("profiles")
    .update({
      full_name: fullName || null,
      division: division || null,
      rank: rank || null,
      team: team || null,
      digital_id: password,
      role: safeRole,
      must_change_password: true, // 초기 비번=디지털식별번호 → 첫 로그인 시 변경 강제
    })
    .eq("id", userId);
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

console.log(`\n완료 — 생성 ${created} · 기존 갱신 ${updated} · 건너뜀 ${skipped} · 실패 ${failed}`);
