// 분야(카테고리) 상수 — 챗봇 분야 필터·AI 자료제작 분야 선택에 사용.
// (학습/진도/이수 기능은 2026-06-18 제거됨 — buildCourses·Course 등은 더 이상 없음.)

export const COURSE_CATEGORIES = ["산악", "수난", "화재", "구급", "일반구조"] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];
