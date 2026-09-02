import { z } from "zod";

import {
  AUDIENCES,
  DURATIONS,
  MAX_GENERATION_CONDITIONS_CHARS,
  SLIDE_DECK_MODES,
} from "@/lib/generate";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

const optionalDate = z
  .string()
  .trim()
  .max(10)
  .refine((value) => value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value))
  .transform((value) => value || undefined)
  .optional();

/** 동기 생성과 영속 Workflow가 함께 사용하는 요청 계약. */
export const generateRequestSchema = z
  .object({
    type: z.enum(["plan", "lesson", "slides"]),
    category: z.string().trim().min(1).max(50),
    audience: z.enum(AUDIENCES),
    duration: z.enum(DURATIONS),
    topic: z.string().trim().min(2).max(100),
    focus: optionalText(100),
    date: optionalDate,
    place: optionalText(100),
    conditions: optionalText(MAX_GENERATION_CONDITIONS_CHARS),
    slideMode: z.enum(SLIDE_DECK_MODES).optional(),
    model: optionalText(100),
  })
  .strip();

export type ValidatedGenerateRequest = z.infer<typeof generateRequestSchema>;
