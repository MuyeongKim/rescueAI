"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 자료실 원본 PDF 업로드 폼 (관리자). 비공개 버킷에 서명 URL로 브라우저가 직접 업로드.
const CATEGORIES = [
  "산악",
  "수난",
  "화재",
  "구급",
  "화학사고",
  "드론 운용",
  "장비 관리",
  "현장지휘·공통",
  "복무·행정",
];
const DIFFICULTIES = ["초급", "중급", "고급"];

export function DocumentUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [publishDate, setPublishDate] = useState("");
  const [uploading, setUploading] = useState(false);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && !title) setTitle(f.name.replace(/\.pdf$/i, ""));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return toast.error("PDF 파일을 선택하세요.");
    if (file.type !== "application/pdf") return toast.error("PDF 파일만 업로드할 수 있습니다.");
    if (!title.trim()) return toast.error("제목을 입력하세요.");

    setUploading(true);
    try {
      // 1) 서명 업로드 URL 발급
      const signRes = await fetch("/api/admin/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign",
          filename: file.name,
          contentType: file.type,
        }),
      });
      if (!signRes.ok) throw new Error(await signRes.text());
      const { path, token } = await signRes.json();

      // 2) 브라우저 → Storage 직접 업로드(서버 용량제한 우회)
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from("documents")
        .uploadToSignedUrl(path, token, file, { contentType: file.type });
      if (upErr) throw new Error(upErr.message);

      // 3) documents 행 생성
      const createRes = await fetch("/api/admin/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title: title.trim(),
          category: category || null,
          difficulty: difficulty || null,
          publishDate: publishDate || null,
          path,
          originalFilename: file.name,
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text());

      toast.success("자료가 업로드되었습니다.");
      setTitle("");
      setCategory("");
      setDifficulty("");
      setPublishDate("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (err) {
      toast.error("업로드 실패", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  }

  const selectCls =
    "h-11 w-full rounded-md border border-input bg-background px-3 text-base";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="file" className="text-sm">
          PDF 파일
        </Label>
        <Input
          id="file"
          ref={fileRef}
          type="file"
          accept="application/pdf"
          required
          onChange={onPickFile}
          className="h-11"
          disabled={uploading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="title" className="text-sm">
          제목
        </Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="자료 제목"
          className="h-11"
          disabled={uploading}
          required
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="category" className="text-sm">
            분야
          </Label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={selectCls}
            disabled={uploading}
          >
            <option value="">선택 안 함</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="difficulty" className="text-sm">
            난이도
          </Label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className={selectCls}
            disabled={uploading}
          >
            <option value="">선택 안 함</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="publishDate" className="text-sm">
            발행일(선택)
          </Label>
          <Input
            id="publishDate"
            type="date"
            value={publishDate}
            onChange={(e) => setPublishDate(e.target.value)}
            className="h-11"
            disabled={uploading}
          />
        </div>
      </div>
      <Button type="submit" className="h-11 gap-2" disabled={uploading}>
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
        업로드
      </Button>
    </form>
  );
}
