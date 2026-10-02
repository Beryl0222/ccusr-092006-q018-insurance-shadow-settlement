import assert from "node:assert/strict";
import test from "node:test";
import { freezeSnapshot } from "../src/domain/catalog.js";
import { replayEvent, DIFF_CATEGORIES } from "../src/domain/replay.js";
import { standardSnapshotInput, historyEvent } from "./helpers/fixtures.js";

function replay(lines, { serviceDate = "2026-03-01T10:00:00.000Z", facility = "t3", inputOverrides = {} } = {}) {
  const snap = freezeSnapshot(standardSnapshotInput(inputOverrides));
  const event = historyEvent({ service_date: serviceDate, facility_level: facility, lines });
  return { snap, comparison: replayEvent(snap, event) };
}

function byRef(comparison, ref) {
  return comparison.diffs.find((d) => d.line_ref === ref);
}

test("现行与候选金额一致且同范围 -> MATCH", () => {
  const input = standardSnapshotInput({
    sample_rates: [
      { id: "rl", track: "current", code: "L01", facility_level: "t3", rate: 40 },
      { id: "rn", track: "candidate", code: "N01", facility_level: "t3", rate: 40 },
    ],
    restrictions: [],
  });
  const { comparison } = replay(
    [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 40 }],
    { inputOverrides: input },
  );
  assert.equal(byRef(comparison, "a").category, DIFF_CATEGORIES.MATCH);
});

test("无国家映射 -> CODE_MISSING，候选行为 missing", () => {
  const { comparison } = replay([{ line_ref: "a", local_code: "L05", quantity: 1, charged_amount: 10 }]);
  const d = byRef(comparison, "a");
  assert.equal(d.category, DIFF_CATEGORIES.CODE_MISSING);
  assert.equal(d.candidate.status, "missing");
  assert.ok(d.rule_basis.some((r) => r.reason === "NO_NATIONAL_MAPPING"));
});

test("多条候选映射 -> RULE_CONFLICT 且列出全部候选", () => {
  const input = standardSnapshotInput({
    mappings: [
      ...standardSnapshotInput().mappings,
      { mapping_id: "m01b", local_code: "L01", national_code: "N02", basis: "歧义映射" },
    ],
  });
  const { comparison } = replay([{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }], { inputOverrides: input });
  const d = byRef(comparison, "a");
  assert.equal(d.category, DIFF_CATEGORIES.RULE_CONFLICT);
  assert.deepEqual(d.candidate.resolved_codes.sort(), ["N01", "N02"]);
  assert.ok(d.rule_basis.some((r) => r.reason === "MULTIPLE_MAPPINGS"));
});

test("互斥国家项目同次共现 -> RULE_CONFLICT，规则依据指向互斥规则", () => {
  const { comparison } = replay([
    { line_ref: "a", local_code: "L03", quantity: 1, charged_amount: 50 },
    { line_ref: "b", local_code: "L04", quantity: 1, charged_amount: 50 },
  ]);
  const a = byRef(comparison, "a");
  const b = byRef(comparison, "b");
  assert.equal(a.category, DIFF_CATEGORIES.RULE_CONFLICT);
  assert.equal(b.category, DIFF_CATEGORIES.RULE_CONFLICT);
  assert.ok(a.rule_basis.some((r) => r.reason === "MUTUALLY_EXCLUSIVE" && r.rule_id === "mutex-n03-n04"));
});

test("支付范围由纳入变排除 -> SCOPE_CHANGE，双轨规则依据都可追溯", () => {
  const { comparison } = replay([{ line_ref: "a", local_code: "L02", quantity: 1, charged_amount: 50 }]);
  const d = byRef(comparison, "a");
  assert.equal(d.category, DIFF_CATEGORIES.SCOPE_CHANGE);
  assert.equal(d.current.scope, "included");
  assert.equal(d.candidate.scope, "excluded");
  assert.equal(d.candidate.amount, null);
});

test("数量上限封顶且费率变化 -> AMOUNT_CHANGE，金额差=候选-现行", () => {
  // L01: current 50*5=250; candidate 费率40、上限2 -> 80；delta=-170
  const { comparison } = replay([{ line_ref: "a", local_code: "L01", quantity: 5, charged_amount: 250 }]);
  const d = byRef(comparison, "a");
  assert.equal(d.category, DIFF_CATEGORIES.AMOUNT_CHANGE);
  assert.equal(d.current.amount, 250);
  assert.equal(d.candidate.amount, 80);
  assert.equal(d.amount_delta, -170);
  assert.ok(d.rule_basis.some((r) => r.reason === "QUANTITY_CAPPED" && r.max_quantity === 2));
});

test("候选费率缺失 -> AMOUNT_CHANGE 且标记不可比", () => {
  const { comparison } = replay([{ line_ref: "a", local_code: "L02", quantity: 1, charged_amount: 50 }]);
  // L02 的候选是被排除的范围规则覆盖；换一个无费率也无范围规则的路径：
  const input = standardSnapshotInput({
    restrictions: [],
    sample_rates: [{ id: "rl", track: "current", code: "L01", facility_level: "t3", rate: 50 }],
  });
  const snap = freezeSnapshot(input);
  const c2 = replayEvent(snap, historyEvent({ lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  const d = byRef(c2, "a");
  assert.equal(d.category, DIFF_CATEGORIES.AMOUNT_CHANGE);
  assert.equal(d.undetermined, true);
  assert.equal(d.candidate.amount, null);
});

test("按就医发生时点选择费率版本", () => {
  const input = standardSnapshotInput({
    restrictions: [],
    sample_rates: [
      { id: "rl", track: "current", code: "L01", facility_level: "t3", rate: 50 },
      { id: "rn-old", track: "candidate", code: "N01", facility_level: "t3", rate: 30, valid_to: "2026-06-30T00:00:00Z" },
      { id: "rn-new", track: "candidate", code: "N01", facility_level: "t3", rate: 70, valid_from: "2026-07-01T00:00:00Z" },
    ],
  });
  const snap = freezeSnapshot(input);
  const before = replayEvent(snap, historyEvent({ service_date: "2026-03-01T10:00:00Z", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  const after = replayEvent(snap, historyEvent({ service_date: "2026-08-01T10:00:00Z", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  assert.equal(byRef(before, "a").candidate.amount, 30);
  assert.equal(byRef(after, "a").candidate.amount, 70);
});

test("机构等级参与规则与费率匹配", () => {
  const input = standardSnapshotInput({
    restrictions: [
      { id: "scope-community-only", track: "candidate", rule_type: "scope", codes: ["N01"], scope: "excluded", facility_levels: ["t1"], basis: "一级机构不予支付 N01" },
    ],
    sample_rates: [
      { id: "rn", track: "candidate", code: "N01", facility_level: "t3", rate: 40 },
    ],
  });
  const snap = freezeSnapshot(input);
  const t1 = replayEvent(snap, historyEvent({ facility_level: "t1", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 0 }] }));
  const t3 = replayEvent(snap, historyEvent({ facility_level: "t3", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 40 }] }));
  assert.equal(byRef(t1, "a").candidate.scope, "excluded");
  assert.equal(byRef(t3, "a").candidate.scope, "included");
});

test("重放是纯函数：同快照同事件 comparison_id 与结果稳定", () => {
  const { snap, comparison } = replay([{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }]);
  const again = replayEvent(snap, historyEvent({ lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  assert.equal(again.comparison_id, comparison.comparison_id);
  assert.deepEqual(again.diffs, comparison.diffs);
  assert.equal(again.current_total, comparison.current_total);
});
