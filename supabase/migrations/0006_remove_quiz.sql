-- 0006_remove_quiz.sql — 퀴즈 기능 제거
-- 회의 결정(2026-06-11): 퀴즈 이수 대신 "분야의 모든 자료 학습 완료 = 이수"로 단순화.
-- 진도는 lesson_progress 가 계속 담당한다.

drop table if exists quiz_attempts;
