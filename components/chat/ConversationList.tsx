"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Menu, Plus, Search, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { DEMO, demoConversations } from "@/lib/demo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

type Conv = { id: string; title: string | null; updated_at: string };

function fmt(d: string): string {
  try {
    return format(new Date(d), "MM.dd HH:mm");
  } catch {
    return "";
  }
}

export function ConversationList({ activeId }: { activeId?: string }) {
  const [open, setOpen] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (DEMO) {
      setConvs(demoConversations);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from("conversations")
        .select("id, title, updated_at")
        .order("updated_at", { ascending: false })
        .limit(100);
      if (!cancelled) {
        setConvs(data ?? []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = convs.filter(
    (c) => !q.trim() || (c.title ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="대화 목록">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[88vw] max-w-sm flex-col p-0">
        <SheetHeader className="border-b p-4 text-left">
          <SheetTitle>대화 목록</SheetTitle>
        </SheetHeader>

        <div className="space-y-2 p-3">
          <Link href="/chat" onClick={() => setOpen(false)}>
            <Button className="h-11 w-full gap-2">
              <Plus className="h-4 w-4" /> 새 대화
            </Button>
          </Link>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="제목 검색"
              className="h-11 pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 불러오는 중…
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {q ? "검색 결과가 없습니다." : "대화 기록이 없습니다."}
            </p>
          ) : (
            filtered.map((c) => (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                onClick={() => setOpen(false)}
                className={cn(
                  "block rounded-md px-3 py-2.5 hover:bg-accent",
                  c.id === activeId && "bg-accent"
                )}
              >
                <div className="truncate text-sm font-medium">
                  {c.title || "새 대화"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmt(c.updated_at)}
                </div>
              </Link>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
