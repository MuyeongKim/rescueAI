"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, Send, Trash2, Pin, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type NewsItem = {
  id: number;
  title: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  region: string | null;
  category: string | null;
  date: string;
  pinned: boolean;
  hidden: boolean;
  auto: boolean;
};

const CATEGORIES = ["수난", "화재", "산악", "구급", "드론", "붕괴·매몰", "구조일반"];
const selectCls =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-base";

export function NewsManager({ items }: { items: NewsItem[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [region, setRegion] = useState("전국");
  const [category, setCategory] = useState("");
  const [publishedOn, setPublishedOn] = useState("");
  const [pinned, setPinned] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function aiSummarize() {
    if (!title.trim()) return toast.error("제목을 먼저 입력하세요.");
    setSummarizing(true);
    try {
      const res = await fetch("/api/admin/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "summarize", title, text: summary, source }),
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      setSummary(r.summary ?? summary);
      if (r.region) setRegion(r.region);
      if (r.category) setCategory(r.category);
      toast.success("AI 요약·분류 완료");
    } catch (e) {
      toast.error("AI 요약 실패", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSummarizing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("제목을 입력하세요.");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          title,
          summary,
          source,
          url,
          region,
          category,
          publishedOn: publishedOn || null,
          pinned,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("동향을 등록했습니다.");
      setTitle(""); setSummary(""); setSource(""); setUrl("");
      setRegion("전국"); setCategory(""); setPublishedOn(""); setPinned(false);
      router.refresh();
    } catch (e) {
      toast.error("등록 실패", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function toggle(id: number, field: "pinned" | "hidden", value: boolean) {
    const res = await fetch("/api/admin/news", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", id, field, value }),
    });
    if (!res.ok) return toast.error(await res.text());
    router.refresh();
  }

  async function remove(id: number, t: string) {
    if (!confirm(`'${t}' 동향을 삭제할까요?`)) return;
    const res = await fetch("/api/admin/news", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return toast.error(await res.text());
    toast.success("삭제되었습니다.");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {/* 작성 폼 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">동향 추가</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="t" className="text-sm">제목</Label>
              <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} className="h-11" required />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="s" className="text-sm">요약</Label>
                <Button type="button" variant="outline" size="sm" className="gap-1" onClick={aiSummarize} disabled={summarizing}>
                  {summarizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  AI 요약·분류
                </Button>
              </div>
              <Textarea id="s" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3}
                placeholder="원문/메모를 붙여넣고 'AI 요약·분류'를 누르면 요약·지역·분야가 자동 채워집니다." />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="src" className="text-sm">출처</Label>
                <Input id="src" value={source} onChange={(e) => setSource(e.target.value)} className="h-11" placeholder="소방청 보도자료 등" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="u" className="text-sm">원문 링크(선택)</Label>
                <Input id="u" value={url} onChange={(e) => setUrl(e.target.value)} className="h-11" placeholder="https://" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r" className="text-sm">지역</Label>
                <select id="r" value={region} onChange={(e) => setRegion(e.target.value)} className={selectCls}>
                  <option value="전국">전국</option>
                  <option value="해외">해외</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="c" className="text-sm">분야</Label>
                <input id="c" list="news-cats" value={category} onChange={(e) => setCategory(e.target.value)} className={selectCls} placeholder="수난/화재/…" />
                <datalist id="news-cats">
                  {CATEGORIES.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="d" className="text-sm">날짜(선택)</Label>
                <Input id="d" type="date" value={publishedOn} onChange={(e) => setPublishedOn(e.target.value)} className="h-11" />
              </div>
              <label className="flex items-center gap-2 pt-7 text-sm">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="h-4 w-4" />
                상단 고정
              </label>
            </div>
            <Button type="submit" className="h-11 gap-2" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              등록
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 목록 */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">전체 동향 {items.length}건</h2>
        {items.length === 0 ? (
          <p className="rounded-md border py-8 text-center text-sm text-muted-foreground">
            아직 동향이 없습니다.
          </p>
        ) : (
          items.map((n) => (
            <Card key={n.id} className={n.hidden ? "opacity-60" : ""}>
              <CardContent className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {n.region && <Badge variant={n.region === "해외" ? "default" : "secondary"}>{n.region}</Badge>}
                    {n.category && <Badge variant="outline" className="font-normal">{n.category}</Badge>}
                    {n.auto && <Badge variant="outline" className="font-normal">자동</Badge>}
                    {n.pinned && <Badge className="gap-1"><Pin className="h-3 w-3" />고정</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{n.date}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium">{n.title}</p>
                  {n.summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.summary}</p>}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" title={n.pinned ? "고정 해제" : "고정"}
                    onClick={() => toggle(n.id, "pinned", !n.pinned)}>
                    <Pin className={n.pinned ? "h-4 w-4 text-primary" : "h-4 w-4 text-muted-foreground"} />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" title={n.hidden ? "표시" : "숨김"}
                    onClick={() => toggle(n.id, "hidden", !n.hidden)}>
                    {n.hidden ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    title="삭제" onClick={() => remove(n.id, n.title)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
