"use client";

import type { GeneratedSlide, SlideDeckMode } from "@/lib/generate";
import { useId } from "react";
import { buildSlideLayoutPlan, SLIDE_LAYOUT_LABELS, SLIDE_TITLE_BOX, slideTitleFontSize, slideAccentTextColor, type SlideColor } from "@/lib/slide-layout";
import { cn } from "@/lib/utils";

const PX = 96;
const WIDTH = 13.33 * PX;
const HEIGHT = 7.5 * PX;

/** PPTX와 같은 문장·도형·좌표를 사용한다. 파일의 실제 글꼴 환경에 따라 줄바꿈은 달라질 수 있다. */
export function SlidePlanPreview({
  slide, index, accent, decorative = false, mode = "presenter", occurrence = 0,
}: {
  slide: GeneratedSlide; index: number; accent: string; decorative?: boolean;
  mode?: SlideDeckMode; occurrence?: number;
}) {
  const plan = buildSlideLayoutPlan(slide, mode, occurrence);
  const meta = SLIDE_LAYOUT_LABELS[plan.layout];
  const arrowId = `slide-arrow-${useId().replace(/:/g, "")}`;
  const colors: Record<SlideColor, string> = {
    ink: "#1a2b4a", body: "#2b3648", accent, muted: "#6b7280",
    tint: "#f4f6f9", white: "#ffffff", line: "#e5e7eb",
  };
  const imageData = slide.visual?.imageData;
  const hasImage = typeof imageData === "string" && /^data:image\/(?:png|jpe?g|gif);base64,/i.test(imageData);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn("aspect-video w-full overflow-hidden rounded-md border shadow-sm", plan.dark ? "bg-[#12233f]" : "bg-white")}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `슬라이드 ${index + 1} 미리보기: ${meta.label}`}
      data-slide-layout={plan.layout}
    >
      <defs><marker id={arrowId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill={accent} /></marker></defs>
      <rect width={WIDTH} height={HEIGHT} fill={plan.dark ? "#12233f" : "#ffffff"} />
      <rect x={0.72 * PX} y={0.47 * PX} width={0.64 * PX} height={0.64 * PX} rx={8} fill={accent} />
      <text x={1.04 * PX} y={0.89 * PX} fontSize={26} textAnchor="middle" fill="white" fontWeight="bold">{index + 1}</text>
      <foreignObject x={SLIDE_TITLE_BOX.x * PX} y={SLIDE_TITLE_BOX.y * PX} width={SLIDE_TITLE_BOX.w * PX} height={SLIDE_TITLE_BOX.h * PX}>
        <div style={{ height: "100%", display: "flex", alignItems: "center", fontSize: slideTitleFontSize(slide.title) * PX / 72, lineHeight: 1.14, fontWeight: 700, color: plan.dark ? "white" : colors.ink, overflowWrap: "anywhere" }}>{slide.title || "제목을 입력해 주세요"}</div>
      </foreignObject>
      <line x1={0.72 * PX} y1={1.36 * PX} x2={12.61 * PX} y2={1.36 * PX} stroke={plan.dark ? "#31415e" : colors.line} />
      <text x={0.9 * PX} y={1.89 * PX} fontSize={21} fill={plan.dark ? "#9fb0cb" : slideAccentTextColor(accent)} fontWeight="bold">{meta.eyebrow}</text>
      {plan.shapes.map((shape, position) => {
        const x = shape.x * PX, y = shape.y * PX, w = shape.w * PX, h = shape.h * PX;
        const fill = shape.fill ? colors[shape.fill] : "none";
        const stroke = shape.stroke ? colors[shape.stroke] : "none";
        if (shape.kind === "line") return <line key={position} x1={x} y1={y} x2={x + w} y2={y + h} stroke={stroke} strokeWidth={2} markerEnd={shape.arrow ? `url(#${arrowId})` : undefined} />;
        if (shape.kind === "ellipse") return <ellipse key={position} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={2} />;
        if (shape.kind === "diamond") return <polygon key={position} points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} fill={fill} stroke={stroke} strokeWidth={2} />;
        return <rect key={position} x={x} y={y} width={w} height={h} rx={shape.kind === "roundRect" ? 8 : 0} fill={fill} stroke={stroke} strokeWidth={2} />;
      })}
      {plan.image && (hasImage ? (
        <image href={imageData} x={plan.image.x * PX} y={plan.image.y * PX} width={plan.image.w * PX} height={plan.image.h * PX} preserveAspectRatio={slide.visual?.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"} />
      ) : (
        <g>
          <rect x={plan.image.x * PX} y={plan.image.y * PX} width={plan.image.w * PX} height={plan.image.h * PX} fill={colors.tint} stroke={accent} strokeDasharray="8 6" />
          <text x={(plan.image.x + plan.image.w / 2) * PX} y={(plan.image.y + plan.image.h / 2) * PX} textAnchor="middle" fontSize={26} fill={colors.muted}>원문 그림 확인 전</text>
        </g>
      ))}
      {plan.texts.map((item) => (
        <foreignObject key={item.id} data-slide-text={item.id} x={item.x * PX} y={item.y * PX} width={item.w * PX} height={item.h * PX}>
          <div style={{ fontSize: item.fontSize * PX / 72, lineHeight: 1.12, color: item.color === "accent" ? slideAccentTextColor(accent, plan.dark) : colors[item.color], fontWeight: item.bold ? 700 : 400, textAlign: item.align ?? "left", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{item.text}</div>
        </foreignObject>
      ))}
      <line x1={0.72 * PX} y1={6.96 * PX} x2={12.61 * PX} y2={6.96 * PX} stroke={plan.dark ? "#31415e" : colors.line} />
      <text x={0.72 * PX} y={7.22 * PX} fontSize={12} fill={plan.dark ? "#9fb0cb" : colors.muted}>전북특별자치도 소방본부</text>
      <text x={12.6 * PX} y={7.22 * PX} fontSize={12} textAnchor="end" fill={accent}>{index + 1}</text>
    </svg>
  );
}
