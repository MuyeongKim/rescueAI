import { generationJobAction } from "@/lib/generation-job-actions";
export const maxDuration = 100;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return generationJobAction(request, (await params).id, "cancel");
}
