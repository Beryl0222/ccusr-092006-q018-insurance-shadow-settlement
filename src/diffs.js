// 差异分析读模型（影子侧专用）：汇总 → 分类明细 → 单事件规则依据，三级下钻。
// 只读归约状态中的"有效比较"，绝不连接真实结算或患者查询侧。

import { DIFF_KINDS } from "./insurance_shadow_settlement.js";

const KINDS = [DIFF_KINDS.CODE_MISSING, DIFF_KINDS.RULE_CONFLICT, DIFF_KINDS.SCOPE_CHANGE];

function effectiveComparisons(store, { candidateCatalogHash = null, region = null } = {}) {
  const out = [];
  for (const comparison of store.state.comparisons.values()) {
    if (candidateCatalogHash && comparison.deps.candidate_catalog !== candidateCatalogHash) continue;
    if (region) {
      const claim = store.state.claims.get(comparison.claim_id)?.claim;
      if (!claim || claim.region !== region) continue;
    }
    out.push(comparison);
  }
  return out;
}

// 第一级：汇总（可按候选目录版本、地区过滤）。
export function diffSummary(store, filter = {}) {
  const comparisons = effectiveComparisons(store, filter);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const byRegion = {};
  let affectedClaims = 0;
  let totalEligibleIncumbent = 0;
  let totalEligibleCandidate = 0;

  for (const c of comparisons) {
    totalEligibleIncumbent += c.incumbent.totals.total_eligible;
    totalEligibleCandidate += c.candidate.totals.total_eligible;
    const claimRegion = store.state.claims.get(c.claim_id)?.claim.region ?? "UNKNOWN";
    if (c.diffs.length) affectedClaims += 1;
    for (const d of c.diffs) {
      byKind[d.kind] += 1;
      byRegion[claimRegion] ??= Object.fromEntries(KINDS.map((k) => [k, 0]));
      byRegion[claimRegion][d.kind] += 1;
    }
  }

  return {
    filter,
    claims_compared: comparisons.length,
    claims_with_diff: affectedClaims,
    diff_count: Object.values(byKind).reduce((a, b) => a + b, 0),
    by_kind: byKind,
    by_region: byRegion,
    eligible_amount: {
      incumbent: round2(totalEligibleIncumbent),
      candidate: round2(totalEligibleCandidate),
      delta: round2(totalEligibleCandidate - totalEligibleIncumbent),
    },
  };
}

// 第二级：某分类下钻到具体差异条目（可继续按第三级取单事件依据）。
export function drillDown(store, { kind, ...filter }) {
  if (!KINDS.includes(kind)) throw new Error(`未知差异分类:${kind}`);
  const rows = [];
  for (const c of effectiveComparisons(store, filter)) {
    const claim = store.state.claims.get(c.claim_id)?.claim;
    for (const d of c.diffs) {
      if (d.kind !== kind) continue;
      rows.push({
        claim_id: c.claim_id,
        region: claim?.region ?? null,
        line_id: d.line_id,
        local_code: d.local_code,
        resolved_code: d.resolved_code,
        message: d.message,
        incumbent: d.incumbent,
        candidate: d.candidate,
      });
    }
  }
  return { kind, count: rows.length, rows };
}

// 第三级：单事件完整规则依据（每条依据指向具体冻结快照哈希与规则号）。
export function diffDetail(store, claimId) {
  const comparison = store.effectiveComparison(claimId);
  if (!comparison) return null;
  const claim = store.state.claims.get(claimId)?.claim ?? null;
  return {
    claim_id: claimId,
    claim_hash: comparison.claim_hash,
    produced_by_event: comparison.event_id,
    supersedes_event_id: comparison.supersedes_event_id,
    job_id: comparison.job_id,
    claim_snapshot: claim,
    deps: comparison.deps,
    incumbent: comparison.incumbent,
    candidate: comparison.candidate,
    diffs: comparison.diffs.map((d) => ({
      kind: d.kind,
      line_id: d.line_id,
      local_code: d.local_code,
      resolved_code: d.resolved_code,
      message: d.message,
      rule_basis: d.rule_basis,
    })),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
