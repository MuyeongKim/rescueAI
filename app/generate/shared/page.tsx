import Link from "next/link";
import { Users } from "lucide-react";

import { listSharedMaterials } from "@/lib/generated-materials";
import { SavedList } from "@/components/generate/SavedList";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

// 동료가 공유한 AI 자료제작 결과물을 열람·다운로드·복제하는 갤러리(읽기 전용).
export default async function SharedMaterialsPage() {
  const items = await listSharedMaterials(100);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="자료 제작 · 공유 보관함"
        title="동료가 만든 자료"
        description="공유된 훈련계획·교안·슬라이드를 다운로드하거나 내 자료로 복제할 수 있습니다."
        icon={Users}
        status={`${items.length}건 공유`}
      />

      {items.length === 0 ? (
        <p className="border border-l-4 border-l-primary py-12 text-center text-sm text-muted-foreground">
          아직 공유된 자료가 없습니다.{" "}
          <Link
            href="/generate/saved"
            className="font-medium text-primary underline underline-offset-2"
          >
            저장한 자료
          </Link>
          에서 ‘공유’를 켜면 동료에게 보여집니다.
        </p>
      ) : (
        <SavedList initial={items} mode="shared" />
      )}
    </div>
  );
}
