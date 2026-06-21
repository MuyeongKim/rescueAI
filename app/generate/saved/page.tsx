import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { listMyMaterials } from "@/lib/generated-materials";
import { SavedList } from "@/components/generate/SavedList";

export const dynamic = "force-dynamic";

export default async function SavedMaterialsPage() {
  const items = await listMyMaterials(100);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FolderOpen className="h-5 w-5 text-primary" /> 저장한 자료
        </h1>
        <p className="text-sm text-muted-foreground">
          AI 자료제작에서 저장한 내 자료입니다. 열어보고 다운로드하거나 삭제할 수 있어요.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
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
