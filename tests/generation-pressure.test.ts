import { describe, expect, it } from "vitest";
import { pressureClaims } from "@/lib/generation-pressure";

describe("압력 기준의 대상·용도·범위 보존", () => {
  it("인접 문장과 다음 글머리의 경보 단어를 착용 전 점검 값에 붙이지 않는다", () => {
    expect(pressureClaims("대원 착용 전 잔압 280bar 이상을 확인합니다.\n잔압 경보 75bar를 설명합니다.")
      .map(({ purpose, valueKey }) => [purpose, valueKey]))
      .toEqual([["precheck", "280"], ["alarm", "75"]]);
  });
  it("정격과 경보를 한 문장에 설명해도 각 값의 앞에 붙은 용도를 유지한다", () => {
    expect(pressureClaims("공기호흡기 정격 압력은 300bar이고 잔압 경보는 55bar입니다.")
      .map(({ purpose }) => purpose)).toEqual(["rated", "alarm"]);
  });
  it("더미 설정과 대원 장비, 계산 예시를 구분한다", () => {
    expect(pressureClaims("훈련 전 더미 공기호흡기 잔압 30bar.\n대원 착용 전 잔압 280bar.\n계산 예시에서는 50bar를 사용합니다.")
      .map(({ subject, purpose }) => [subject, purpose]))
      .toEqual([["dummy", "precheck"], ["equipment", "precheck"], ["equipment", "example"]]);
  });
  it("범위의 양끝을 하나로 보존하고 동등한 단위를 정규화한다", () => {
    expect(pressureClaims("경보 45~55bar. 경보 4.5–5.5 MPa. 경보 45-55바.")
      .map(({ valueKey }) => valueKey)).toEqual(["45~55", "45~55", "45~55"]);
  });
  it("일반적인 이상·미만은 명확한 경보 용도를 진입 기준으로 바꾸지 않는다", () => {
    expect(pressureClaims("경보 압력이 설정된 최소 55bar 미만일 때 울립니다.")[0].purpose).toBe("alarm");
  });
  it("수치 뒤의 경보 설명을 일반적인 착용 전 시점보다 우선한다", () => {
    expect(pressureClaims("착용 전 55bar에서 경보가 울리는지 확인합니다.")[0].purpose).toBe("alarm");
    expect(pressureClaims("착용 전 잔압 280bar 이상을 확인하고 경보 55bar를 설명합니다.")
      .map(({ purpose }) => purpose)).toEqual(["precheck", "alarm"]);
  });
});
