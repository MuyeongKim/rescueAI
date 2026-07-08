"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACTIVITIES, MAX_DURATION_MIN } from "@/lib/fitness";

// 운동 기록 입력 폼. 마일리지는 서버가 계산해 응답으로 알려준다.
export function WorkoutForm() {
  const router = useRouter();
  const [activity, setActivity] = useState<string>(ACTIVITIES[0]);
  const [duration, setDuration] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const durationMin = parseInt(duration, 10);
    if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > MAX_DURATION_MIN) {
      toast.error(`운동 시간을 1~${MAX_DURATION_MIN}분 사이로 입력하세요.`);
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/fitness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activity, durationMin, note }),
      });
      if (!res.ok) {
        toast.error(await res.text());
        return;
      }
      const { points } = await res.json();
      toast.success(
        points > 0
          ? `기록 완료! 마일리지 +${points}점 적립`
          : "기록 완료! (오늘 적립 상한에 도달해 추가 적립은 없습니다)"
      );
      setDuration("");
      setNote("");
      router.refresh();
    } catch {
      toast.error("네트워크 오류로 기록하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_8rem_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="activity">운동 종목</Label>
        <Select value={activity} onValueChange={setActivity}>
          <SelectTrigger id="activity" className="h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIVITIES.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="duration">시간(분)</Label>
        <Input
          id="duration"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_DURATION_MIN}
          placeholder="예: 40"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="h-11"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="note">메모 (선택)</Label>
        <Input
          id="note"
          placeholder="예: 5km 인터벌"
          value={note}
          maxLength={100}
          onChange={(e) => setNote(e.target.value)}
          className="h-11"
        />
      </div>

      <Button type="submit" disabled={pending} className="h-11 gap-1.5">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        기록하기
      </Button>
    </form>
  );
}
