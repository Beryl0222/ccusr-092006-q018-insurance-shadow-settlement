// 双轨重放引擎。
//
// 输入一条【脱敏】历史结算事件和一个不可变快照，按就医发生时点
// （service_date）分别在两条轨道上求值：
//   current   —— 本地旧项目、现行支付限制与样例费率；
//   candidate —— 地区映射后的国家项目、候选支付限制与样例费率。
// 两条结果分别产出、分别保存，再逐行比对分类。整个过程是纯函数：
// 相同快照 + 相同事件永远得到相同 comparison_id 与相同结论，
// 因此可以安全地重复重放、分片重放、重启续跑。
//
// 重要：引擎只读取历史事件，绝不回写；现行真实支付状态不被触碰，
// 引擎也不提供任何把候选结果送回真实结算的出口。

import { hashJson } from "./hash.js";

export const DIFF_CATEGORIES = Object.freeze({
  MATCH: "MATCH",
  CODE_MISSING: "CODE_MISSING", // 编码缺失：国家目录无对应项目/映射缺失
  RULE_CONFLICT: "RULE_CONFLICT", // 组合规则冲突：互斥共现 / 多映射歧义
  SCOPE_CHANGE: "SCOPE_CHANGE", // 支付范围变化：纳入<->排除
  AMOUNT_CHANGE: "AMOUNT_CHANGE", // 可比轨道金额/计费数量处理不同（含费率缺失）
});

const round2 = (n) => Math.round(n * 100) / 100;

function effectiveAt(entry, atMs) {
  if (entry.valid_from && Date.parse(entry.valid_from) > atMs) return false;
  if (entry.valid_to && Date.parse(entry.valid_to) <= atMs) return false;
  return true;
}

function facilityMatches(rule, facility) {
  const levels = rule.facility_levels ?? (rule.facility_level ? [rule.facility_level] : ["*"]);
  return levels.includes("*") || levels.includes(facility);
}

// 在某轨道的规则/费率表中按"就医时点 + 机构等级"唯一定位。
function pickEffective(list, predicate, atMs, facility, describe) {
  const hits = list.filter(
    (r) => predicate(r) && facilityMatches(r, facility) && effectiveAt(r, atMs),
  );
  if (hits.length > 1) {
    // 冻结阶段已拒绝区间重叠；走到这里属于数据不变量被破坏。
    throw new Error(`${describe} 在就医时点存在多重命中，快照不变量被破坏`);
  }
  return hits[0] ?? null;
}

function buildTrackIndex(snapshot, track) {
  const codes = track === "current" ? new Set(snapshot.local.codes) : new Set(snapshot.national.codes);
  const restrictions = snapshot.restrictions.filter((r) => r.track === track);
  const rates = snapshot.rates.filter((r) => r.track === track);
  const mappingsByLocal = new Map();
  if (track === "candidate") {
    for (const m of snapshot.mappings) {
      if (!mappingsByLocal.has(m.local_code)) mappingsByLocal.set(m.local_code, []);
      mappingsByLocal.get(m.local_code).push(m);
    }
  }
  return { track, codes, restrictions, rates, mappingsByLocal };
}

// 先解析整单互斥组合，产出"哪些解析后编码落入互斥冲突"。
function detectMutexConflicts(claimCodes, index, atMs, facility) {
  const codeSet = new Set(claimCodes);
  const conflicts = new Map(); // code -> 命中的互斥规则依据列表
  for (const rule of index.restrictions) {
    if (rule.rule_type !== "mutually_exclusive") continue;
    if (!facilityMatches(rule, facility) || !effectiveAt(rule, atMs)) continue;
    const hit = rule.codes.filter((c) => codeSet.has(c));
    if (hit.length >= 2) {
      for (const c of hit) {
        if (!conflicts.has(c)) conflicts.set(c, []);
        conflicts.get(c).push({ reason: "MUTUALLY_EXCLUSIVE", rule_id: rule.id, basis: rule.basis, co_occurring: hit.filter((x) => x !== c) });
      }
    }
  }
  return conflicts;
}

function evaluateLine(line, ctx) {
  const { track, index, atMs, facility, mutexConflicts } = ctx;
  const reasons = [];
  const out = {
    line_ref: line.line_ref ?? null,
    local_code: line.local_code,
    resolved_codes: [],
    code_present: true,
    scope: "included",
    requested_quantity: line.quantity,
    payable_quantity: 0,
    amount: null,
    status: "payable", // payable | excluded | missing | conflict
    reasons,
  };

  // 1) 编码解析
  if (track === "current") {
    if (!index.codes.has(line.local_code)) {
      out.code_present = false;
      out.status = "missing";
      reasons.push({ reason: "CODE_NOT_IN_LOCAL_CATALOG", basis: `本地目录 ${ctx.catalogVersion}` });
      return out;
    }
    out.resolved_codes = [line.local_code];
  } else {
    const maps = index.mappingsByLocal.get(line.local_code) ?? [];
    if (maps.length === 0) {
      out.code_present = false;
      out.status = "missing";
      reasons.push({ reason: "NO_NATIONAL_MAPPING", basis: "地区映射表中无对应国家项目" });
      return out;
    }
    if (maps.length > 1) {
      out.status = "conflict";
      out.resolved_codes = maps.map((m) => m.national_code);
      reasons.push({
        reason: "MULTIPLE_MAPPINGS",
        basis: `同一本地项目存在 ${maps.length} 条候选映射，无法唯一确定国家项目`,
        mapping_ids: maps.map((m) => m.mapping_id),
        options: maps.map((m) => ({ national_code: m.national_code, mapping_id: m.mapping_id, basis: m.basis })),
      });
      return out;
    }
    out.resolved_codes = [maps[0].national_code];
    reasons.push({ reason: "MAPPED", mapping_id: maps[0].mapping_id, basis: maps[0].basis });
  }

  const code = out.resolved_codes[0];

  // 2) 支付范围（scope）
  const scopeRule = pickEffective(
    index.restrictions,
    (r) => r.rule_type === "scope" && r.codes[0] === code,
    atMs,
    facility,
    "支付范围规则",
  );
  if (scopeRule) {
    out.scope = scopeRule.scope;
    reasons.push({ reason: "SCOPE_RULE", rule_id: scopeRule.id, scope: scopeRule.scope, basis: scopeRule.basis });
  }
  if (out.scope === "excluded") {
    out.status = "excluded";
    return out;
  }

  // 3) 组合互斥（候选国家项目维度的组合规则）
  const mutex = mutexConflicts.get(code);
  if (mutex) {
    out.status = "conflict";
    reasons.push(...mutex);
    return out;
  }

  // 4) 数量上限
  let payableQty = line.quantity;
  const qtyRule = pickEffective(
    index.restrictions,
    (r) => r.rule_type === "max_quantity" && r.codes.includes(code),
    atMs,
    facility,
    "数量上限规则",
  );
  if (qtyRule && line.quantity > qtyRule.max_quantity) {
    payableQty = qtyRule.max_quantity;
    reasons.push({
      reason: "QUANTITY_CAPPED",
      rule_id: qtyRule.id,
      max_quantity: qtyRule.max_quantity,
      basis: qtyRule.basis,
    });
  }
  out.payable_quantity = payableQty;

  // 5) 样例费率（按就医时点 + 机构等级）
  const rateEntry = pickEffective(
    index.rates,
    (r) => r.code === code,
    atMs,
    facility,
    "样例费率",
  );
  if (!rateEntry) {
    out.status = "payable";
    out.amount = null;
    reasons.push({ reason: "RATE_MISSING", basis: "就医时点无适用样例费率，金额不可比" });
  } else {
    out.amount = round2(rateEntry.rate * payableQty);
    reasons.push({ reason: "RATE_APPLIED", rate_id: rateEntry.id, rate: rateEntry.rate, basis: rateEntry.basis });
  }
  return out;
}

function evaluateTrack(snapshot, event, track) {
  const index = buildTrackIndex(snapshot, track);
  const atMs = Date.parse(event.service_date);
  const facility = event.facility_level ?? "standard";
  // 候选轨：互斥在"国家项目编码"整单层面判定；现行轨在本地编码层面判定。
  const claimCodes = [];
  if (track === "candidate") {
    for (const line of event.lines) {
      for (const m of index.mappingsByLocal.get(line.local_code) ?? []) claimCodes.push(m.national_code);
    }
  } else {
    for (const line of event.lines) if (index.codes.has(line.local_code)) claimCodes.push(line.local_code);
  }
  const mutexConflicts = detectMutexConflicts(claimCodes, index, atMs, facility);

  const line_results = event.lines.map((line) =>
    evaluateLine(line, { track, index, atMs, facility, mutexConflicts, catalogVersion: snapshot.local.version }),
  );
  const total_amount = round2(
    line_results.reduce((sum, l) => sum + (l.amount ?? 0), 0),
  );
  return { track, line_results, total_amount };
}

function classifyPair(cur, cand) {
  // 编码缺失优先：候选轨解析不出国家项目。
  if (cand.status === "missing") {
    return { category: DIFF_CATEGORIES.CODE_MISSING, rule_basis: cand.reasons };
  }
  if (cur.status === "missing") {
    return { category: DIFF_CATEGORIES.CODE_MISSING, rule_basis: cur.reasons };
  }
  // 组合规则冲突（多映射歧义 / 互斥共现）。
  if (cand.status === "conflict" || cur.status === "conflict") {
    return {
      category: DIFF_CATEGORIES.RULE_CONFLICT,
      rule_basis: [...cand.reasons, ...cur.reasons],
    };
  }
  // 支付范围变化。
  if (cur.scope !== cand.scope) {
    return {
      category: DIFF_CATEGORIES.SCOPE_CHANGE,
      rule_basis: [
        ...cur.reasons.filter((r) => r.reason === "SCOPE_RULE"),
        ...cand.reasons.filter((r) => r.reason === "SCOPE_RULE"),
      ],
    };
  }
  if (cur.status === "excluded" && cand.status === "excluded") {
    return { category: DIFF_CATEGORIES.MATCH, rule_basis: [], note: "两轨均在支付范围外" };
  }
  // 金额/计费数量处理不同（含费率缺失导致的不可比）。
  // 注意：双轨编码字面不同是映射的正常结果，不构成差异。
  const curAmt = cur.amount;
  const candAmt = cand.amount;
  const qtyChanged = cur.payable_quantity !== cand.payable_quantity;
  if (curAmt === null || candAmt === null) {
    return {
      category: DIFF_CATEGORIES.AMOUNT_CHANGE,
      rule_basis: [...cur.reasons, ...cand.reasons].filter(
        (r) => ["RATE_MISSING", "RATE_APPLIED", "QUANTITY_CAPPED"].includes(r.reason),
      ),
      note: "至少一轨缺少适用样例费率，金额不可直接比较",
      undetermined: true,
    };
  }
  if (curAmt !== candAmt || qtyChanged) {
    return {
      category: DIFF_CATEGORIES.AMOUNT_CHANGE,
      amount_delta: round2(candAmt - curAmt),
      rule_basis: [...cur.reasons, ...cand.reasons].filter((r) =>
        ["RATE_MISSING", "RATE_APPLIED", "QUANTITY_CAPPED", "MAPPED"].includes(r.reason),
      ),
    };
  }
  return { category: DIFF_CATEGORIES.MATCH, rule_basis: [] };
}

// 对一条历史事件执行双轨重放，返回现行结果、候选结果与逐行差异。
export function replayEvent(snapshot, event) {
  const current = evaluateTrack(snapshot, event, "current");
  const candidate = evaluateTrack(snapshot, event, "candidate");

  const diffs = event.lines.map((line, i) => {
    const cur = current.line_results[i];
    const cand = candidate.line_results[i];
    const verdict = classifyPair(cur, cand);
    return {
      line_ref: line.line_ref ?? `${i + 1}`,
      local_code: line.local_code,
      category: verdict.category,
      current: {
        resolved_codes: cur.resolved_codes,
        scope: cur.scope,
        status: cur.status,
        payable_quantity: cur.payable_quantity,
        amount: cur.amount,
        reasons: cur.reasons,
      },
      candidate: {
        resolved_codes: cand.resolved_codes,
        scope: cand.scope,
        status: cand.status,
        payable_quantity: cand.payable_quantity,
        amount: cand.amount,
        reasons: cand.reasons,
      },
      amount_delta: verdict.amount_delta ?? null,
      undetermined: Boolean(verdict.undetermined),
      note: verdict.note ?? null,
      rule_basis: verdict.rule_basis,
    };
  });

  const totals = {
    current_total: current.total_amount,
    candidate_total: candidate.total_amount,
    total_delta: round2(candidate.total_amount - current.total_amount),
  };
  const comparison_id = `cmp_${hashJson([
    snapshot.snapshot_id,
    event.event_ref,
    event.service_date,
  ]).slice(0, 16)}`;

  return {
    comparison_id,
    snapshot_id: snapshot.snapshot_id,
    content_hash: snapshot.content_hash,
    event_ref: event.event_ref,
    subject_ref: event.subject_ref,
    region: event.region,
    service_date: event.service_date,
    replayed_at: new Date(0).toISOString(), // 纯函数占位；由服务层盖实际时间，保证可复算
    current_result: current,
    candidate_result: candidate,
    diffs,
    ...totals,
  };
}

// 差异汇总（供下钻视图使用）。
export function summarizeDiffs(comparison) {
  const byCategory = new Map();
  for (const d of comparison.diffs) {
    const entry = byCategory.get(d.category) ?? { category: d.category, lines: 0, abs_delta: 0 };
    entry.lines += 1;
    entry.abs_delta += Math.abs(d.amount_delta ?? 0);
    byCategory.set(d.category, entry);
  }
  return [...byCategory.values()].map((e) => ({ ...e, abs_delta: round2(e.abs_delta) }));
}
