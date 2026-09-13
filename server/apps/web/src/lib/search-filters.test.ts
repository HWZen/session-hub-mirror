import { describe, expect, it } from "vitest";
import { dateToMs, hasAnyFilter, toApiFilters, toSearchParams } from "./search-filters";

describe("dateToMs", () => {
  it("空串返回 undefined", () => {
    expect(dateToMs("", "start")).toBeUndefined();
    expect(dateToMs("   ", "end")).toBeUndefined();
  });

  it("start 取本地当日 00:00:00.000", () => {
    expect(dateToMs("2026-03-05", "start")).toBe(new Date("2026-03-05T00:00:00.000").getTime());
  });

  it("end 取本地当日 23:59:59.999", () => {
    expect(dateToMs("2026-03-05", "end")).toBe(new Date("2026-03-05T23:59:59.999").getTime());
  });

  it("非法日期返回 undefined", () => {
    expect(dateToMs("not-a-date", "start")).toBeUndefined();
  });
});

describe("toApiFilters", () => {
  it("剔除空值", () => {
    expect(toApiFilters({})).toEqual({});
    expect(toApiFilters({ agent: "", machine: "  ", title: "", source_id: "" })).toEqual({});
  });

  it("字符串去空格、日期转毫秒", () => {
    expect(
      toApiFilters({ agent: " opencode ", title: " 会话 ", created_from: "2026-03-05", updated_to: "2026-03-06" }),
    ).toEqual({
      agent: "opencode",
      title: "会话",
      created_from: new Date("2026-03-05T00:00:00.000").getTime(),
      updated_to: new Date("2026-03-06T23:59:59.999").getTime(),
    });
  });
});

describe("toSearchParams", () => {
  it("日期保持日历字符串", () => {
    expect(toSearchParams({ created_from: "2026-03-05", created_to: "2026-03-06", source_id: "abc" })).toEqual({
      created_from: "2026-03-05",
      created_to: "2026-03-06",
      source_id: "abc",
    });
  });

  it("剔除空值", () => {
    expect(toSearchParams({ title: " ", agent: undefined })).toEqual({});
  });
});

describe("hasAnyFilter", () => {
  it("无过滤返回 false", () => {
    expect(hasAnyFilter({})).toBe(false);
    expect(hasAnyFilter({ title: "  " })).toBe(false);
  });

  it("任一过滤返回 true", () => {
    expect(hasAnyFilter({ agent: "opencode" })).toBe(true);
    expect(hasAnyFilter({ created_from: "2026-03-05" })).toBe(true);
  });
});
