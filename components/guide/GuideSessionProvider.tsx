"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

const GuideSessionContext = createContext({ dismissed: false, dismiss: () => {} });

/** 계정 설정 저장 중의 메뉴 이동도 같은 화면 세션의 닫기를 유지한다. */
export function GuideSessionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (pathname === "/login") setDismissed(false);
  }, [pathname]);
  const value = useMemo(() => ({ dismissed, dismiss: () => setDismissed(true) }), [dismissed]);
  return <GuideSessionContext.Provider value={value}>{children}</GuideSessionContext.Provider>;
}

export function useGuideSession() { return useContext(GuideSessionContext); }
