"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRight, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CategoryBadge } from "@/components/learning/CategoryBadge";

export type DocRow = {
  id: number;
  title: string;
  category: string | null;
  equipment: string[] | null;
  difficulty: string | null;
  file_url: string | null;
  publish_date: string | null;
  source_type: string;
};

const CATEGORIES = ["전체", "산악", "수난", "화재", "구급"] as const;
const DIFFICULTIES = ["전체", "초급", "중급", "고급"] as const;

function fmtDate(d: string | null): string {
  if (!d) return "-";
  try {
    return format(new Date(d), "yyyy.MM.dd");
  } catch {
    return d;
  }
}

export function DocsBrowser({ documents }: { documents: DocRow[] }) {
  const [category, setCategory] = useState<string>("전체");
  const [difficulty, setDifficulty] = useState<string>("전체");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents.filter((d) => {
      if (category !== "전체" && d.category !== category) return false;
      if (difficulty !== "전체" && d.difficulty !== difficulty) return false;
      if (q && !d.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [documents, category, difficulty, query]);

  return (
    <div className="space-y-4">
      {/* 필터 */}
      <div className="space-y-3">
        <Tabs value={category} onValueChange={setCategory}>
          <TabsList className="flex w-full flex-wrap">
            {CATEGORIES.map((c) => (
              <TabsTrigger key={c} value={c} className="flex-1">
                {c}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목 검색"
              aria-label="자료 제목 검색"
              className="h-11 pl-9 text-base"
            />
          </div>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger className="h-11 w-28" aria-label="난이도 선택">
              <SelectValue placeholder="난이도" />
            </SelectTrigger>
            <SelectContent>
              {DIFFICULTIES.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 표 */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>제목</TableHead>
              <TableHead className="hidden sm:table-cell">분야</TableHead>
              <TableHead className="hidden md:table-cell">장비</TableHead>
              <TableHead className="hidden sm:table-cell">발행일</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-10 text-center text-muted-foreground"
                >
                  자료가 없습니다.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="p-0 font-medium">
                    <Link
                      href={`/docs/${d.id}`}
                      className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-label={`${d.title} 열기`}
                    >
                      <span className="min-w-0">
                        <span className="block">{d.title}</span>
                        <span className="mt-1 flex gap-1 sm:hidden">
                          {d.category && <CategoryBadge category={d.category} />}
                          {d.difficulty && (
                            <Badge variant="outline" className="text-xs font-normal">
                              {d.difficulty}
                            </Badge>
                          )}
                        </span>
                      </span>
                      <ChevronRight
                        className="h-5 w-5 shrink-0 text-muted-foreground sm:hidden"
                        aria-hidden
                      />
                    </Link>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {d.category ? <CategoryBadge category={d.category} /> : "-"}
                  </TableCell>
                  <TableCell className="hidden max-w-[220px] truncate md:table-cell">
                    {d.equipment && d.equipment.length > 0
                      ? d.equipment.join(", ")
                      : "-"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell whitespace-nowrap text-muted-foreground">
                    {fmtDate(d.publish_date)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        총 {filtered.length}건
      </p>
    </div>
  );
}
