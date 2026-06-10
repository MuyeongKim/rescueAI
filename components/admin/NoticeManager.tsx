"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pin, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Notice = {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  created_at: string;
};

// 공지 작성 폼 + 목록(삭제). 작성/삭제는 /api/admin/notices 경유(관리자 검증).
export function NoticeManager({ notices }: { notices: Notice[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pinned, setPinned] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error("제목과 내용을 입력하세요.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/admin/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, pinned }),
      });
      if (!res.ok) {
        toast.error(await res.text());
        return;
      }
      toast.success("공지를 등록했습니다.");
      setTitle("");
      setContent("");
      setPinned(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("이 공지를 삭제할까요?")) return;
    const res = await fetch("/api/admin/notices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      toast.error(await res.text());
      return;
    }
    toast.success("공지를 삭제했습니다.");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">새 공지 작성</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="notice-title">제목</Label>
              <Input
                id="notice-title"
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 6월 구조 기술 경연대회 안내"
                className="h-11"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notice-content">내용</Label>
              <Textarea
                id="notice-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="공지 내용을 입력하세요."
                rows={5}
                required
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(e) => setPinned(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                상단 고정
              </label>
              <Button type="submit" disabled={pending} className="h-11 gap-1.5">
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                등록
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">등록된 공지 {notices.length}건</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {notices.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              등록된 공지가 없습니다.
            </p>
          ) : (
            notices.map((n) => (
              <div
                key={n.id}
                className="flex items-start justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {n.pinned && (
                      <Badge variant="secondary" className="gap-1">
                        <Pin className="h-3 w-3" /> 고정
                      </Badge>
                    )}
                    <span className="font-medium">{n.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {n.created_at.slice(0, 10)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {n.content}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="공지 삭제"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(n.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
