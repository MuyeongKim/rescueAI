"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// 사용자 권한 변경 셀렉트. 본인 계정은 서버에서 거부된다.
export function UserRoleSelect({
  userId,
  role,
  disabled,
}: {
  userId: string;
  role: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function change(next: string) {
    if (next === role) return;
    setPending(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: next }),
      });
      if (!res.ok) {
        toast.error(await res.text());
        return;
      }
      toast.success("권한을 변경했습니다.");
      router.refresh();
    } catch {
      toast.error("네트워크 오류로 변경하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Select value={role} onValueChange={change} disabled={disabled || pending}>
      <SelectTrigger className="h-9 w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="user">일반</SelectItem>
        <SelectItem value="admin">관리자</SelectItem>
      </SelectContent>
    </Select>
  );
}
