import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { listMyMaterials } from "@/lib/generated-materials";
import { SavedList } from "@/components/generate/SavedList";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

export default async function SavedMaterialsPage() {
  const items = await listMyMaterials(100);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="자료 제작 · 개인 보관함"
        title="저장한 자료"
        description="AI 자료제작에서 저장한 자료를 열람하고 다운로드하거나 삭제할 수 있습니다."
        icon={FolderOpen}
        status={`${items.length}건 저장`}
      />

      {items.length === 0 ? (
        <p className="border border-l-4 border-l-primary py-12 text-center text-sm text-muted-foreground">
          아직 저장한 자료가 없습니다.{" "}
          <Link href="/generate" className="font-medium text-primary underline underline-offset-2">
            AI 자료제작
          </Link>
          에서 만들고 저장해 보세요.
        </p>
      ) : (
        <SavedList initial={items} />
      )}
    </div>
  );
}
