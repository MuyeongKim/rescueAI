import { describe, it, expect } from "vitest";
import { buildCourses, type LessonDoc } from "@/lib/courses";

const docs: LessonDoc[] = [
  { id: 1, title: "고급 로프", category: "산악", difficulty: "고급", publish_date: "2024-01-01" },
  { id: 2, title: "초급 매듭", category: "산악", difficulty: "초급", publish_date: "2024-01-01" },
  { id: 3, title: "중급 하강", category: "산악", difficulty: "중급", publish_date: "2024-01-01" },
  { id: 4, title: "수난 기초", category: "수난", difficulty: "초급", publish_date: "2024-02-01" },
  { id: 5, title: "분류없음", category: null, difficulty: null, publish_date: null },
];

describe("buildCourses", () => {
  it("카테고리별로 과정을 만들고 카테고리 없는 자료는 제외한다", () => {
    const courses = buildCourses(docs, new Set());
    const cats = courses.map((c) => c.category);
    expect(cats).toContain("산악");
    expect(cats).toContain("수난");
    expect(cats).not.toContain(null);
    const 산악 = courses.find((c) => c.category === "산악")!;
    expect(산악.total).toBe(3);
  });

  it("레슨을 난이도(초급→중급→고급) 순으로 정렬한다", () => {
    const courses = buildCourses(docs, new Set());
    const 산악 = courses.find((c) => c.category === "산악")!;
    expect(산악.lessons.map((l) => l.difficulty)).toEqual(["초급", "중급", "고급"]);
    expect(산악.lessons.map((l) => l.order)).toEqual([1, 2, 3]);
  });

  it("완료한 레슨으로 진도율을 계산한다", () => {
    const courses = buildCourses(docs, new Set([2, 3]));
    const 산악 = courses.find((c) => c.category === "산악")!;
    expect(산악.completed).toBe(2);
    expect(산악.progress).toBe(67); // round(2/3*100)
    expect(산악.certified).toBe(false); // 전부 완료 아님
  });

  it("모든 레슨을 완료하면 이수(certified)", () => {
    const courses = buildCourses(docs, new Set([1, 2, 3]));
    const 산악 = courses.find((c) => c.category === "산악")!;
    expect(산악.progress).toBe(100);
    expect(산악.certified).toBe(true);
  });

  it("자료가 없는 과정은 이수가 아니다", () => {
    const courses = buildCourses([], new Set());
    expect(courses).toHaveLength(0);
  });
});
