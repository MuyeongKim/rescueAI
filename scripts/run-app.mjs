import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertDatabaseEnvironment } from "./lib/database-environment.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("dev, build, start 중 실행할 명령을 지정해 주세요.");
const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, NODE_ENV: command === "dev" ? "development" : "production" };

if (env.VERCEL_ENV !== "production") {
  const localPath = new URL("../.env.development.local", import.meta.url);
  if (existsSync(localPath)) Object.assign(env, parseEnv(readFileSync(localPath, "utf8")));
  // Next의 .env.local 폴백이 과거 운영 자격증명을 섞지 못하게 명시적으로 비운다.
  for (const key of [
    "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY",
    "LLM_API_URL", "EMBEDDING_API_URL", "HWP_WRITER_API_KEY", "HWP_WRITER_API_URL", "CRON_SECRET",
  ]) env[key] ??= "";
}

const registry = JSON.parse(readFileSync(new URL("../config/database-environments.json", import.meta.url), "utf8"));
try { assertDatabaseEnvironment(env, registry); } catch (error) {
  console.error(error instanceof Error ? error.message : "데이터베이스 환경 설정을 확인해 주세요.");
  process.exit(1);
}

const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), command, ...args], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Next.js를 시작하지 못했습니다."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
