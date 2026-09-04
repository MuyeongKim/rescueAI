"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { generationDraftFingerprint, type GenerationDraft, type GenerationDraftSnapshot } from "@/lib/generation-draft";

type DraftState = { status: "idle" | "pending" | "saving" | "saved" | "error" | "conflict"; message?: string; id?: string };

/** 편집을 직렬 보관하고 링크 이동·새 제작 전에 최신 스냅샷의 보관을 확인한다. */
export function useGenerationDraft({ enabled, draftKey, snapshot, initialDraft }: {
  enabled: boolean; draftKey: string | null; snapshot: GenerationDraftSnapshot | null; initialDraft?: GenerationDraft;
}) {
  const [state, setState] = useState<DraftState>({ status: initialDraft ? "saved" : "idle", id: initialDraft?.id });
  const [forkedKey, setForkedKey] = useState<{ original: string; copy: string } | null>(null);
  const effectiveKey = forkedKey?.original === draftKey ? forkedKey.copy : draftKey;
  const stateRef = useRef(state);
  const writeState = useCallback((next: DraftState) => { stateRef.current = next; setState(next); }, []);
  const identities = useRef(new Map<string, { revision: number; fingerprint: string; id?: string }>(
    initialDraft ? [[initialDraft.draftKey, { revision: initialDraft.revision, fingerprint: generationDraftFingerprint(initialDraft.snapshot), id: initialDraft.id }]] : []
  ));
  const latest = useRef<{ key: string; snapshot: GenerationDraftSnapshot; fingerprint: string } | null>(null);
  let fingerprint = "";
  let invalid = false;
  if (snapshot && enabled) {
    try { fingerprint = generationDraftFingerprint(snapshot); } catch { invalid = true; }
  }
  latest.current = enabled && effectiveKey && snapshot && fingerprint ? { key: effectiveKey, snapshot: JSON.parse(fingerprint), fingerprint } : null;
  const invalidRef = useRef(false);
  invalidRef.current = enabled && Boolean(snapshot) && invalid;
  const inFlight = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const failureToast = useRef<string | number | null>(null);
  const reportFailure = useCallback((next: DraftState) => {
    stateRef.current = next;
    if (mounted.current) setState(next);
    if (failureToast.current === null) {
      failureToast.current = toast.error("편집 초안을 보관하지 못했습니다", {
        description: `${next.message ?? "연결 상태를 확인해 주세요."} 현재 화면을 유지하고 보관 상태를 확인해 주세요.`,
        duration: 10_000,
      });
    }
  }, []);

  const flush = useCallback(async (): Promise<boolean> => {
    if (invalidRef.current) {
      reportFailure({ status: "error", message: "편집 내용이 임시보관 가능한 분량을 넘었습니다. 분량을 줄인 뒤 다시 시도해 주세요." });
      return false;
    }
    if (inFlight.current) {
      if (!(await inFlight.current)) return false;
      return flush();
    }
    if (!latest.current) return true;
    const pending = latest.current;
    const identity = identities.current.get(pending.key) ?? { revision: 0, fingerprint: "" };
    if (identity.fingerprint === pending.fingerprint) return true;
    if (stateRef.current.status === "conflict") return false;
    const operation = (async () => {
      if (mounted.current) writeState({ status: "saving", id: identity.id });
      try {
        const response = await fetch("/api/generate/drafts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftKey: pending.key, revision: identity.revision, snapshot: pending.snapshot }),
          signal: AbortSignal.timeout(35_000),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const next: DraftState = { status: payload?.code === "draft_revision_conflict" ? "conflict" : "error",
            message: payload?.error ?? "편집 초안을 보관하지 못했습니다. 다시 시도해 주세요.", id: payload?.draftId ?? identity.id };
          reportFailure(next);
          return false;
        }
        const row = payload?.draft;
        if (!row || typeof row.id !== "string" || !Number.isInteger(row.revision)) throw new Error("초안 보관 응답을 확인하지 못했습니다.");
        identities.current.set(pending.key, { revision: row.revision, fingerprint: pending.fingerprint, id: row.id });
        if (failureToast.current !== null) {
          toast.dismiss(failureToast.current);
          failureToast.current = null;
        }
        const next: DraftState = { status: "saved", id: row.id };
        stateRef.current = next;
        if (mounted.current) setState(next);
        return true;
      } catch {
        const next: DraftState = { status: "error", message: "편집 초안 보관이 지연되고 있습니다. 현재 화면을 유지하고 다시 시도해 주세요.", id: identity.id };
        reportFailure(next);
        return false;
      }
    })();
    inFlight.current = operation;
    const ok = await operation;
    inFlight.current = null;
    if (!ok) return false;
    return flush();
  }, [reportFailure, writeState]);

  const unsynced = invalid || Boolean(latest.current && identities.current.get(latest.current.key)?.fingerprint !== fingerprint);
  const unsyncedRef = useRef(unsynced);
  unsyncedRef.current = unsynced;
  useEffect(() => {
    if (!enabled || !draftKey || !fingerprint || !unsynced || stateRef.current.status === "conflict") return;
    writeState({ status: "pending", id: identities.current.get(draftKey)?.id });
    const timer = window.setTimeout(() => { void flush(); }, 700);
    return () => window.clearTimeout(timer);
  }, [draftKey, enabled, fingerprint, flush, unsynced, writeState]);

  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsyncedRef.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    const navigate = (event: MouseEvent) => {
      if (!unsyncedRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.href === window.location.href || anchor.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void flush().then((ok) => { if (ok) window.location.assign(anchor.href); });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", navigate, true);
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", navigate, true);
      // 브라우저 뒤로 가기 등 SPA 이동에서도 아직 대기 중인 마지막 변경을 서버로 보낸다.
      if (unsyncedRef.current) void flush();
    };
  }, [flush]);

  async function saveCopy(): Promise<boolean> {
    const pending = latest.current;
    if (!pending || !draftKey) return false;
    if (inFlight.current) await inFlight.current;
    const copy = `local:${crypto.randomUUID()}`;
    latest.current = { ...pending, key: copy };
    setForkedKey({ original: draftKey, copy });
    writeState({ status: "pending" });
    return flush();
  }
  return { ...state, unsynced, flush, saveCopy };
}
