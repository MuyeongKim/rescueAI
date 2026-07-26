"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { WorkoutForm } from "@/components/fitness/WorkoutForm";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function WorkoutEntrySheet() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex justify-end">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button className="h-12 w-full gap-2 text-base sm:w-auto">
            <Plus className="h-5 w-5" aria-hidden />
            운동 기록하기
          </Button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-none border-t-4 border-t-primary pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto max-w-4xl">
            <SheetHeader className="text-left">
              <SheetTitle className="text-xl font-extrabold">운동 기록하기</SheetTitle>
              <SheetDescription>
                오늘 수행한 종목과 시간을 입력하면 마일리지가 자동으로 계산됩니다.
              </SheetDescription>
            </SheetHeader>
            <div className="mt-5">
              <WorkoutForm onSuccess={() => setOpen(false)} />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
