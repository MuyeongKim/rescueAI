import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 다운로드 파일명 안전화 — LLM이 만든 제목에 / : ? * 등이 섞이면 OS/브라우저에서
// 저장이 깨지거나 경로로 해석될 수 있어 제거한다. 확장자는 호출부에서 붙인다.
export function sanitizeFilename(name: string, max = 50): string {
  const cleaned = (name || "")
    .replace(/[/\\:*?"<>|]/g, " ") // 파일명 금지 문자
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || "문서";
}
