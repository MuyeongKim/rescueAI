import Link from "next/link";
import { Users } from "lucide-react";

import { listSharedMaterials } from "@/lib/generated-materials";
import { SavedList } from "@/components/generate/SavedList";

export const dynamic = "force-dynamic";

// 동료가 공유한 AI 자료제작 결과물을 열람·다운로드·복제하는 갤러리(읽기 전용).
export default async function SharedMaterialsPage() {
  const items = await listSharedMaterials(100);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Users className="h-5 w-5 text-primary" /> 동료가 만든 자료
        </h1>
        <p className="text-sm text-muted-foreground">
          다른 대원이 공유한 훈련계획·교안·슬라이드입니다. 다운로드하거나 내 자료로 복제해
          편집할 수 있어요.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
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
