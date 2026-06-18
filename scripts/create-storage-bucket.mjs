// 자료실 원본 PDF 저장용 Storage 버킷 생성 (관리자용, 서버에서만 실행).
// 비공개 버킷 — 열람/다운로드는 서버가 service role로 만든 "서명 URL"로만. (직접 URL 추측 불가)
// 새 프로젝트/내부망 이전 시 1회 실행:  node scripts/create-storage-bucket.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  process.exit(1);
}

const BUCKET = "documents";
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: existing } = await sb.storage.getBucket(BUCKET);
if (existing) {
  console.log(`이미 존재: 버킷 '${BUCKET}' (public=${existing.public})`);
  process.exit(0);
}

const { error } = await sb.storage.createBucket(BUCKET, {
  public: false, // 비공개 — 서명 URL로만 접근
  allowedMimeTypes: ["application/pdf"],
  fileSizeLimit: "52428800", // 50MB
});
if (error) {
  console.error("버킷 생성 실패:", error.message);
  process.exit(1);
}
console.log(`✅ 버킷 '${BUCKET}' 생성 완료 (비공개, PDF만, 최대 50MB)`);
