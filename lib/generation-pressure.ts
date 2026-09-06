/** Pressure mentions retain sentence boundaries, purpose and the actual equipment user.
 * This detects internal contradictions, not whether a threshold is safe or source-supported. */
export type PressurePurpose = "alarm" | "withdrawal" | "test" | "rated" | "entry" | "precheck" | "example" | "operating";

const PURPOSES: Array<[PressurePurpose, RegExp]> = [
  ["example", /계산\s*(?:예시|예|상)|산출\s*예시|예를\s*들|가정\s*(?:값|압력)/g],
  ["alarm", /경보(?:음|기)?|알람/g],
  ["withdrawal", /퇴각|철수|탈출\s*(?:기준|압력)/g],
  ["test", /기밀|누설|시험\s*압력/g],
  ["rated", /정격|최대\s*충전|완충|충전\s*(?:기준|압력)/g],
  ["entry", /진입/g],
  ["precheck", /착용\s*전|사용\s*전|출동\s*전|훈련\s*전|평가\s*전|착용\s*점검|준비|시작\s*압력/g],
];

function closestPurpose(text: string, before: boolean): PressurePurpose | null {
  let selected: PressurePurpose | null = null;
  let nearest = Infinity;
  for (const [kind, pattern] of PURPOSES) {
    for (const cue of text.matchAll(pattern)) {
      const distance = before ? text.length - cue.index - cue[0].length : cue.index;
      if (distance < nearest) { nearest = distance; selected = kind; }
    }
  }
  return selected;
}

export function pressureClaims(text: string) {
  const claims: Array<{
    raw: string; valueKey: string; purpose: PressurePurpose; subject: "dummy" | "equipment";
    context: string;
  }> = [];
  const normalized = text.normalize("NFKC");
  // Do not borrow an adjacent bullet's cue or source title. Preserve decimal points.
  for (const sentence of normalized.split(/[\n;!?。]|\.(?!\d)/)) {
    const matches = Array.from(sentence.matchAll(/(\d{1,4}(?:\.\d+)?)\s*(?:[~∼–-]\s*(\d{1,4}(?:\.\d+)?)\s*)?(bar|바|mpa)(?![a-z])/gi));
    matches.forEach((match, index) => {
      const previous = matches[index - 1];
      const next = matches[index + 1];
      const before = sentence.slice(previous ? previous.index + previous[0].length : 0, match.index);
      const after = sentence.slice(match.index + match[0].length, next?.index ?? sentence.length);
      // Labels immediately preceding a value beat generic qualifiers such as '이상'.
      const preceding = closestPurpose(before, true);
      const directAfter = after.split(/[,，]|이고|이며|하고|한\s*(?:뒤|후)|합니다/)[0];
      const following = closestPurpose(directAfter, false);
      const purpose = (preceding === "precheck" && following && following !== "entry" && following !== "precheck")
        ? following : preceding ?? following ?? "operating";
      const context = `${before}${match[0]}${after}`.trim();
      const dummyBefore = /더미|마네킹|인체\s*모형/.test(before);
      const wearerBefore = /대원|착용자|구조자/.test(before);
      const subject = dummyBefore && !wearerBefore ? "dummy"
        : /더미|마네킹|인체\s*모형/.test(sentence) && !/대원|착용자|구조자/.test(sentence)
          ? "dummy" : "equipment";
      const scale = match[3].toLowerCase() === "mpa" ? 10 : 1;
      const values = [match[1], match[2]].filter(Boolean).map((value) => Number((Number(value) * scale).toFixed(6)));
      claims.push({ raw: match[0], valueKey: values.join("~"), purpose, subject, context });
    });
  }
  return claims;
}
