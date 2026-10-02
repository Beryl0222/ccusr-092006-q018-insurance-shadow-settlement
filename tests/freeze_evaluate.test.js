import assert from "node:assert/strict";
import test from "node:test";
import { FreezeRegistry, hashContent } from "../src/freeze.js";
import { replayClaim } from "../src/evaluate.js";
import { DIFF_KINDS } from "../src/insurance_shadow_settlement.js";
import {
  incumbentCatalog, incumbentRestriction, incumbentRates,
  candidateCatalog, candidateRestriction, candidateRates,
  mappingRevision1, REGION_A,
} from "../examples/fixtures.js";

function registryWithMapping(mappingContent) {
  const r = new FreezeRegistry();
  const put = (artifact_type, side, region, version, content, from) =>
    r.put({ artifact_type, side, region, version, content, frozen_at: from, effective_from: from });
  const incCat = put("CATALOG", "INCUMBENT", REGION_A, "v1", incumbentCatalog(REGION_A), "2025-01-01");
  const incRes = put("RESTRICTION", "INCUMBENT", REGION_A, "v1", incumbentRestriction(REGION_A), "2025-01-01");
  const incRate = put("RATE_TABLE", "INCUMBENT", REGION_A, "v1", incumbentRates(REGION_A), "2025-01-01");
  const candCat = put("CATALOG", "CANDIDATE", "NATIONAL", "v1", candidateCatalog(), "2026-08-01");
  const candRes = put("RESTRICTION", "CANDIDATE", "NATIONAL", "v1", candidateRestriction(), "2026-08-01");
  const candRate = put("RATE_TABLE", "CANDIDATE", "NATIONAL", "v1", candidateRates(), "2026-08-01");
  const mapping = r.put({
    artifact_type: "MAPPING", side: "CANDIDATE", region: REGION_A, version: "1",
    content: mappingContent, frozen_at: "2026-09-01", effective_from: "2026-09-01",
  }, { timeline: false });
  return {
    r,
    refs: {
      incumbent: { catalog: incCat.content_hash, restriction: incRes.content_hash, rate: incRate.content_hash },
      candidate: { catalog: candCat.content_hash, restriction: candRes.content_hash, rate: candRate.content_hash },
      mapping: mapping.content_hash,
    },
  };
}

test("冻结对象以内容哈希为身份且不可变", () => {
  const r = new FreezeRegistry();
  const a = r.put({
    artifact_type: "CATALOG", side: "CANDIDATE", region: "NATIONAL", version: "v1",
    content: { b: 2, a: 1 }, frozen_at: "2026-08-01", effective_from: "2026-08-01",
    effective_to: "2026-12-31T23:59:59+08:00",
  });
  const b = r.put({
    artifact_type: "CATALOG", side: "CANDIDATE", region: "NATIONAL", version: "v1",
    content: { a: 1, b: 2 }, frozen_at: "2026-08-01", effective_from: "2026-08-01",
  });
  assert.equal(a.content_hash, b.content_hash); // 键顺序不影响哈希
  assert.throws(() => { a.content.items = {}; }, TypeError);
  assert.throws(() => {
    r.put({
      artifact_type: "CATALOG", side: "CANDIDATE", region: "NATIONAL", version: "v2",
      content: { x: 1 }, frozen_at: "2026-08-02", effective_from: "2026-08-02",
    });
  }, /冻结区间/);
  // 区间不重叠的新版本允许
  const c = r.put({
    artifact_type: "CATALOG", side: "CANDIDATE", region: "NATIONAL", version: "v1",
    content: { x: 1 }, frozen_at: "2027-01-01", effective_from: "2027-01-01",
  });
  assert.notEqual(c.content_hash, a.content_hash);
});

test("按就医发生时点选择有效版本", () => {
  const r = new FreezeRegistry();
  const v1 = r.put({
    artifact_type: "RATE_TABLE", side: "CANDIDATE", region: "NATIONAL", version: "v1",
    content: { rates: {} }, frozen_at: "2026-08-01", effective_from: "2026-08-01",
    effective_to: "2026-12-31T23:59:59+08:00",
  });
  r.put({
    artifact_type: "RATE_TABLE", side: "CANDIDATE", region: "NATIONAL", version: "v2",
    content: { rates: {} }, frozen_at: "2027-01-01", effective_from: "2027-01-01",
  });
  assert.equal(r.effectiveAt("RATE_TABLE", "CANDIDATE", "NATIONAL", "2026-10-01").version, "v1");
  assert.equal(r.effectiveAt("RATE_TABLE", "CANDIDATE", "NATIONAL", "2027-02-01").version, "v2");
  assert.throws(() => r.effectiveAt("RATE_TABLE", "CANDIDATE", "NATIONAL", "2025-01-01"), /无有效冻结版本/);
  void v1;
});

test("重放：编码缺失、组合规则冲突、支付范围变化三类差异齐备且带规则依据", () => {
  const { r, refs } = registryWithMapping(mappingRevision1());

  const claims = [
    { // L009 在修订1中无映射 -> CODE_MISSING
      claim_id: "clm-aaaaaa", patient_token: "pat-aaaaaa", region: REGION_A, setting: "OPD",
      service_date: "2026-03-10", lines: [{ line_id: "l1", local_code: "L009", quantity: 1 }],
    },
    { // L003+L004 -> N003+N004 互斥 -> RULE_CONFLICT
      claim_id: "clm-bbbbbb", patient_token: "pat-bbbbbb", region: REGION_A, setting: "OPD",
      service_date: "2026-04-02",
      lines: [{ line_id: "l1", local_code: "L003", quantity: 1 }, { line_id: "l2", local_code: "L004", quantity: 1 }],
    },
    { // L005 -> N005 被明确排除 -> SCOPE_CHANGE
      claim_id: "clm-cccccc", patient_token: "pat-cccccc", region: REGION_A, setting: "IPD",
      service_date: "2026-05-20", lines: [{ line_id: "l1", local_code: "L005", quantity: 1 }],
    },
    { // L006 -> N006 限量2，申报5 -> SCOPE_CHANGE
      claim_id: "clm-dddddd", patient_token: "pat-dddddd", region: REGION_A, setting: "OPD",
      service_date: "2026-06-15", lines: [{ line_id: "l1", local_code: "L006", quantity: 5 }],
    },
  ];

  const kindsPerClaim = claims.map((c) => {
    const result = replayClaim(c, refs, r);
    return { claim_id: c.claim_id, kinds: result.diffs.map((d) => d.kind), result };
  });

  assert.deepEqual(kindsPerClaim[0].kinds, [DIFF_KINDS.CODE_MISSING]);
  assert.deepEqual(kindsPerClaim[1].kinds, [DIFF_KINDS.RULE_CONFLICT]);
  assert.deepEqual(kindsPerClaim[2].kinds, [DIFF_KINDS.SCOPE_CHANGE]);
  assert.deepEqual(kindsPerClaim[3].kinds, [DIFF_KINDS.SCOPE_CHANGE]);

  // 规则依据指向具体快照与规则号
  const ruleConflict = kindsPerClaim[1].result.diffs[0];
  assert.match(ruleConflict.rule_basis[0].artifact_hash, /^sha256:/);
  assert.equal(ruleConflict.rule_basis[0].rule_id, "NR-003-EXCL");

  const capped = kindsPerClaim[3].result;
  const n006 = capped.candidate.line_results.find((l) => l.local_code === "L006");
  assert.equal(n006.effective_quantity, 2);
  assert.equal(n006.line_eligible, 24);

  // 现行结果保持原样：L003 行在现行侧按本地规则不互斥、可付
  const incL003 = kindsPerClaim[1].result.incumbent.line_results.find((l) => l.local_code === "L003");
  assert.equal(incL003.line_eligible, 50);
});

test("纯费率金额差异不计为支付范围变化", () => {
  const { r, refs } = registryWithMapping({ entries: { L001: { national_code: "N001" } } });
  const claim = {
    claim_id: "clm-eeeeee", patient_token: "pat-eeeeee", region: REGION_A, setting: "OPD",
    service_date: "2026-02-01", lines: [{ line_id: "l1", local_code: "L001", quantity: 1 }],
  };
  const result = replayClaim(claim, refs, r);
  assert.deepEqual(result.diffs, []);
  assert.equal(result.incumbent.line_results[0].line_eligible, 20);
  assert.equal(result.candidate.line_results[0].line_eligible, 22);
});

test("内容哈希稳定", () => {
  assert.match(hashContent({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashContent({ a: 1, b: 2 }), hashContent({ b: 2, a: 1 }));
});
