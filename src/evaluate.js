// 重放评估引擎：对一条历史结算事件，分别用现行（本地旧目录）与候选（国家目录）
// 冻结快照各算一次，输出双侧结果与三类差异（编码缺失 / 组合规则冲突 / 支付范围变化）。
// 评估是纯函数：不触碰原始支付状态，也不产生任何对外支付动作。

import { DIFF_KINDS } from "./insurance_shadow_settlement.js";

const round2 = (n) => Math.round(n * 100) / 100;

function rateOf(rates, code) {
  const unit = rates?.content?.rates?.[code];
  return typeof unit === "number" ? unit : null;
}

function restrictionHitsFor(code, setting, quantity, resolvedCodes, restrictionArtifact, catalogItem) {
  const hits = [];
  const add = (rule, blocked, effectiveQuantity) =>
    hits.push({ rule_id: rule.rule_id, type: rule.type, reason: rule.reason, blocked, effective_quantity: effectiveQuantity });

  if (catalogItem && Array.isArray(catalogItem.rules)) {
    for (const rule of catalogItem.rules) {
      if (rule.type === "EXCLUSIVE_WITH") {
        const clash = (rule.codes || []).find((other) => other !== code && resolvedCodes.has(other));
        if (clash) add(rule, true, quantity);
      } else if (rule.type === "REQUIRES_ONE_OF") {
        const ok = (rule.codes || []).some((other) => resolvedCodes.has(other));
        if (!ok) add(rule, true, quantity);
      }
    }
  }

  const rules = restrictionArtifact?.content?.restrictions?.[code] ?? [];
  for (const rule of rules) {
    if (rule.type === "EXCLUDED") add(rule, true, quantity);
    else if (rule.type === "SETTING_ONLY") add(rule, !(rule.settings || []).includes(setting), quantity);
    else if (rule.type === "QUANTITY_MAX") {
      const capped = Math.min(quantity, rule.max);
      add(rule, false, capped); // 限量不阻断，超出部分不予支付
    }
  }
  return hits;
}

// side: "INCUMBENT" 时直接按本地编码解析；"CANDIDATE" 时先经地区映射解析为国家编码。
function evaluateSide(claim, side, refs, registry) {
  const catalog = registry.get(refs.catalog);
  const restriction = registry.get(refs.restriction);
  const rates = registry.get(refs.rate);
  const mapping = refs.mapping ? registry.get(refs.mapping) : null;

  const resolvedCodes = new Set();
  const resolveLine = (line) => {
    if (side === "INCUMBENT") return { code: line.local_code, unmapped: false, via: null };
    const entry = mapping?.content?.entries?.[line.local_code];
    if (!entry) return { code: null, unmapped: true, reason: "地区映射缺少该本地编码", via: null };
    if (!catalog.content.items?.[entry.national_code]) {
      return { code: null, unmapped: true, reason: "映射目标编码不在候选国家目录中", via: entry.national_code };
    }
    return { code: entry.national_code, unmapped: false, via: entry.national_code };
  };

  for (const line of claim.lines) {
    const r = resolveLine(line);
    if (r.code) resolvedCodes.add(r.code);
  }

  const line_results = [];
  let total_charged = 0;
  let total_eligible = 0;

  for (const line of claim.lines) {
    const resolved = resolveLine(line);
    const result = {
      line_id: line.line_id,
      local_code: line.local_code,
      resolved_code: resolved.code,
      unmapped: resolved.unmapped,
      item_present: false,
      unit_rate: null,
      quantity: line.quantity,
      effective_quantity: line.quantity,
      line_charged: 0,
      line_eligible: 0,
      pay_category: null,
      combo_blocked: false,
      scope_excluded: false,
      restriction_hits: [],
    };

    if (resolved.unmapped) {
      line_results.push(result);
      continue;
    }
    const item = catalog.content.items?.[resolved.code];
    result.item_present = Boolean(item);
    result.pay_category = item?.pay_category ?? null;
    const unit = rateOf(rates, resolved.code);
    result.unit_rate = unit;
    if (item && typeof unit === "number") {
      const hits = restrictionHitsFor(resolved.code, claim.setting, line.quantity, resolvedCodes, restriction, item);
      result.restriction_hits = hits.map((h) => ({
        rule_id: h.rule_id,
        type: h.type,
        reason: h.reason,
        source: h.type === "EXCLUSIVE_WITH" || h.type === "REQUIRES_ONE_OF"
          ? catalog.content_hash
          : restriction.content_hash,
      }));
      const comboBlocked = hits.some((h) => h.blocked && (h.type === "EXCLUSIVE_WITH" || h.type === "REQUIRES_ONE_OF"));
      const scopeBlocked = hits.some((h) => h.blocked && h.type !== "EXCLUSIVE_WITH" && h.type !== "REQUIRES_ONE_OF");
      const settingCovered = (item.settings ?? []).includes(claim.setting);
      const capHit = hits.find((h) => h.type === "QUANTITY_MAX");
      result.combo_blocked = comboBlocked;
      result.scope_excluded = scopeBlocked || item.payable === false || !settingCovered;
      result.effective_quantity = capHit ? capHit.effective_quantity : line.quantity;
      result.line_charged = round2(unit * line.quantity);
      result.line_eligible = round2(!result.scope_excluded && !comboBlocked ? unit * result.effective_quantity : 0);
      total_charged += result.line_charged;
      total_eligible += result.line_eligible;
    }
    line_results.push(result);
  }

  return {
    side,
    versions: {
      catalog: catalog.version,
      restriction: restriction.version,
      rate: rates.version,
      mapping_revision: mapping?.version ?? null,
    },
    deps: {
      catalog: catalog.content_hash,
      restriction: restriction.content_hash,
      rate: rates.content_hash,
      mapping: mapping?.content_hash ?? null,
    },
    line_results,
    totals: { total_charged: round2(total_charged), total_eligible: round2(total_eligible) },
  };
}

const basisFromHit = (side, hit) => ({
  side,
  rule_id: hit.rule_id,
  reason: hit.reason,
  artifact_hash: hit.source,
});

// 比较双侧结果，输出带规则依据的差异列表。
function buildDiffs(incumbent, candidate, mappingHash) {
  const diffs = [];
  const incByLine = new Map(incumbent.line_results.map((l) => [l.line_id, l]));

  for (const candLine of candidate.line_results) {
    const incLine = incByLine.get(candLine.line_id);

    if (candLine.unmapped) {
      diffs.push({
        kind: DIFF_KINDS.CODE_MISSING,
        line_id: candLine.line_id,
        local_code: candLine.local_code,
        resolved_code: null,
        message: "候选侧无法解析该本地编码",
        incumbent: { resolved_code: incLine?.resolved_code ?? null, line_eligible: incLine?.line_eligible ?? 0 },
        candidate: { resolved_code: null, line_eligible: 0 },
        rule_basis: [{ side: "CANDIDATE", artifact_hash: mappingHash, rule_id: "MAPPING_ENTRY", reason: "地区映射缺少该条目或目标编码未收录" }],
      });
      continue;
    }

    const incCombo = new Set((incLine?.restriction_hits ?? []).filter((h) => h.type === "EXCLUSIVE_WITH" || h.type === "REQUIRES_ONE_OF").map((h) => h.rule_id));
    const candCombo = candLine.restriction_hits.filter((h) => h.type === "EXCLUSIVE_WITH" || h.type === "REQUIRES_ONE_OF");
    for (const hit of candCombo) {
      if (!incCombo.has(hit.rule_id)) {
        diffs.push({
          kind: DIFF_KINDS.RULE_CONFLICT,
          line_id: candLine.line_id,
          local_code: candLine.local_code,
          resolved_code: candLine.resolved_code,
          message: `候选目录组合规则 ${hit.rule_id} 触发，现行侧未触发：${hit.reason}`,
          incumbent: { triggered: [...incCombo], line_eligible: incLine?.line_eligible ?? 0 },
          candidate: { triggered: candCombo.map((h) => h.rule_id), line_eligible: candLine.line_eligible },
          rule_basis: [basisFromHit("CANDIDATE", hit)],
        });
      }
    }
    for (const hit of (incLine?.restriction_hits ?? [])) {
      if ((hit.type === "EXCLUSIVE_WITH" || hit.type === "REQUIRES_ONE_OF") &&
          !candCombo.some((c) => c.rule_id === hit.rule_id)) {
        diffs.push({
          kind: DIFF_KINDS.RULE_CONFLICT,
          line_id: candLine.line_id,
          local_code: candLine.local_code,
          resolved_code: candLine.resolved_code,
          message: `现行侧组合规则 ${hit.rule_id} 在候选目录中消失：${hit.reason}`,
          incumbent: { triggered: [...incCombo], line_eligible: incLine?.line_eligible ?? 0 },
          candidate: { triggered: candCombo.map((h) => h.rule_id), line_eligible: candLine.line_eligible },
          rule_basis: [basisFromHit("INCUMBENT", hit)],
        });
      }
    }

    // 支付范围变化：类别、适用场景、排除状态或限量发生变化（纯样例费率金额差不在此列）。
    if (incLine && (incLine.scope_excluded !== candLine.scope_excluded ||
        incLine.pay_category !== candLine.pay_category ||
        incLine.effective_quantity !== candLine.effective_quantity)) {
      const basis = [];
      for (const hit of incLine.restriction_hits ?? []) basis.push(basisFromHit("INCUMBENT", hit));
      for (const hit of candLine.restriction_hits ?? []) basis.push(basisFromHit("CANDIDATE", hit));
      diffs.push({
        kind: DIFF_KINDS.SCOPE_CHANGE,
        line_id: candLine.line_id,
        local_code: candLine.local_code,
        resolved_code: candLine.resolved_code,
        message: "支付范围/限量/类别变化导致可付金额不同",
        incumbent: {
          resolved_code: incLine.resolved_code,
          pay_category: incLine.pay_category,
          effective_quantity: incLine.effective_quantity,
          line_eligible: incLine.line_eligible,
        },
        candidate: {
          resolved_code: candLine.resolved_code,
          pay_category: candLine.pay_category,
          effective_quantity: candLine.effective_quantity,
          line_eligible: candLine.line_eligible,
        },
        rule_basis: basis,
      });
    }
  }

  return diffs;
}

// 对一条历史事件重放：现行与候选各算一次，互不影响；返回两侧完整结果、差异与依赖哈希。
export function replayClaim(claim, refs, registry) {
  const incumbent = evaluateSide(claim, "INCUMBENT", refs.incumbent, registry);
  const candidate = evaluateSide(claim, "CANDIDATE", { ...refs.candidate, mapping: refs.mapping }, registry);
  const mappingHash = registry.get(refs.mapping).content_hash;
  const diffs = buildDiffs(incumbent, candidate, mappingHash);
  const deps = {
    incumbent_catalog: incumbent.deps.catalog,
    candidate_catalog: candidate.deps.catalog,
    incumbent_restriction: incumbent.deps.restriction,
    candidate_restriction: candidate.deps.restriction,
    incumbent_rate: incumbent.deps.rate,
    candidate_rate: candidate.deps.rate,
    mapping: mappingHash,
  };
  return { incumbent, candidate, diffs, deps };
}

// 幂等键：同一事件 + 同一套冻结依赖 = 同一条比较；依赖变化时旧比较被新比较取代。
export function comparisonIdempotencyKey(claim, result) {
  return `${claim.claim_id}|${result.deps.candidate_catalog}|${result.deps.mapping}|${result.deps.candidate_restriction}|${result.deps.candidate_rate}|${result.deps.incumbent_catalog}|${result.deps.incumbent_restriction}|${result.deps.incumbent_rate}`;
}
