// 发布门槛：候选目录必须同时通过抽样复核门槛与全部相关地区签署门槛，
// 才具备发布资格。本模块只记录"资格判定"，系统内不存在任何真实发布动作。

import { createHash } from "node:crypto";
import { DIFF_KINDS } from "./insurance_shadow_settlement.js";

const REVIEWER_RE = /^rv-[0-9a-hjkmnpqrstvwxyz]{4,}$/;
const SIGNER_RE = /^sg-[0-9a-hjkmnpqrstvwxyz]{4,}$/;

// 确定性抽样：同一 (catalog_version, region, fraction, seed) 下抽出的成员恒定，
// 可被不同审计者独立复算。
export function selectSampleMembers(store, { catalogVersion, fraction, seed, region = null }) {
  if (!(fraction > 0 && fraction <= 1)) throw new Error("抽样比例必须在 (0,1] 内");
  const candidates = [];
  for (const comparison of store.state.comparisons.values()) {
    if (comparison.deps.candidate_catalog !== catalogVersion) continue;
    if (region) {
      const claimRegion = store.state.claims.get(comparison.claim_id)?.claim.region;
      if (claimRegion !== region) continue;
    }
    candidates.push(comparison.claim_id);
  }
  candidates.sort();
  const seedHash = createHash("sha256").update(seed).digest("hex");
  const selected = candidates.filter((claimId) => {
    const h = createHash("sha256").update(`${seedHash}|${claimId}`).digest();
    return h.readUInt32BE(0) / 0x100000000 < fraction;
  });
  return { members: selected, seed_hash: seedHash };
}

export class ReleaseGatekeeper {
  constructor(store) {
    this.store = store;
  }

  async drawSample({ batchId, catalogVersion, fraction, seed, region = null }, opts = {}) {
    const { members, seed_hash } = selectSampleMembers(this.store, { catalogVersion, fraction, seed, region });
    if (members.length === 0) throw new Error("抽样集合为空：候选目录尚无比较结果");
    await this.store.append("SAMPLE_DRAWN", "release", {
      batch_id: batchId,
      catalog_version: catalogVersion,
      fraction,
      region,
      members,
      seed_hash,
    }, opts);
    return this.store.state.samples.get(batchId);
  }

  async recordRecheck({ batchId, claimId, reviewerToken, verdict, note = "" }, opts = {}) {
    const batch = this.store.state.samples.get(batchId);
    if (!batch) throw new Error(`抽样批次不存在:${batchId}`);
    if (!batch.members.includes(claimId)) throw new Error(`${claimId} 不属于批次 ${batchId}`);
    if (!REVIEWER_RE.test(reviewerToken)) throw new Error("复核人必须使用脱敏令牌");
    if (!["MATCH", "MISMATCH", "DEFER"].includes(verdict)) throw new Error("复核结论非法");
    const key = `${batchId}|${claimId}`;
    if (this.store.state.rechecks.has(key)) throw new Error("该样本已有复核结论，结论不可修改");
    await this.store.append("RECHECK_RECORDED", "release", {
      batch_id: batchId,
      claim_id: claimId,
      reviewer_token: reviewerToken,
      verdict,
      note,
    }, opts);
  }

  async signRegion({ region, catalogVersion, signerToken }, opts = {}) {
    if (!SIGNER_RE.test(signerToken)) throw new Error("签署人必须使用脱敏令牌");
    const current = this.store.currentMapping(region);
    if (!current) throw new Error(`地区 ${region} 尚无映射修订，无法签署`);
    const prior = this.store.state.signoffs.get(region);
    if (prior && prior.catalog_version === catalogVersion &&
        prior.mapping_revision === current.revision) {
      throw new Error("该地区已按当前目录与映射修订签署，勿重复签署");
    }
    await this.store.append("REGION_SIGNED", region, {
      region,
      catalog_version: catalogVersion,
      mapping_revision: current.revision,
      signer_token: signerToken,
    }, opts);
  }

  // 执行资格判定并追加 RELEASE_QUALIFIED 记录。返回判定明细。
  async evaluate({ catalogVersion, batchId, requiredRegions, minSampleFraction = 0.1,
                   minConsistency = 0.95 }, opts = {}) {
    const comparisons = [...this.store.state.comparisons.values()]
      .filter((c) => c.deps.candidate_catalog === catalogVersion);

    // 门槛 1：抽样合规（基于本候选目录、比例达标）。
    const batch = this.store.state.samples.get(batchId);
    const sampleGate = evaluateSampleGate(batch, catalogVersion, minSampleFraction);

    // 门槛 2：抽样复核一致率。
    const recheckGate = evaluateRecheckGate(this.store, batch, minConsistency);

    // 门槛 3：比较结果对现行依赖是最新的（映射修订后已增量重算到位），且无在途作业。
    const freshnessGate = evaluateFreshnessGate(this.store, comparisons, requiredRegions);

    // 门槛 4：必需地区范围内不存在编码缺失（映射必须补齐后才能谈发布）。
    const scopedComparisons = comparisons.filter((c) => {
      const region = this.store.state.claims.get(c.claim_id)?.claim.region;
      return requiredRegions.includes(region);
    });
    const missingCount = scopedComparisons.reduce(
      (n, c) => n + c.diffs.filter((d) => d.kind === DIFF_KINDS.CODE_MISSING).length, 0);
    const missingGate = {
      name: "NO_CODE_MISSING",
      passed: missingCount === 0,
      detail: { code_missing: missingCount },
    };

    // 门槛 5：每个必需地区均已按"当前候选目录 + 当前映射修订"签署。
    const regionGate = evaluateRegionGate(this.store, catalogVersion, requiredRegions);

    const gate_results = [sampleGate, recheckGate, freshnessGate, missingGate, regionGate];
    const decision = gate_results.every((g) => g.passed) ? "QUALIFIED" : "NOT_QUALIFIED";
    await this.store.append("RELEASE_QUALIFIED", "release", {
      catalog_version: catalogVersion,
      batch_id: batchId,
      decision,
      gate_results,
    }, opts);
    return { decision, gate_results };
  }
}

function evaluateSampleGate(batch, catalogVersion, minSampleFraction) {
  if (!batch) return { name: "SAMPLING", passed: false, detail: { reason: "抽样批次不存在" } };
  const passed = batch.catalog_version === catalogVersion &&
    batch.fraction + 1e-12 >= minSampleFraction && batch.members.length > 0;
  return {
    name: "SAMPLING",
    passed,
    detail: {
      fraction: batch.fraction,
      min_fraction: minSampleFraction,
      sample_size: batch.members.length,
      catalog_version_match: batch.catalog_version === catalogVersion,
    },
  };
}

function evaluateRecheckGate(store, batch, minConsistency) {
  if (!batch) return { name: "RECHECK_CONSISTENCY", passed: false, detail: { reason: "抽样批次不存在" } };
  const records = batch.members.map((id) => store.state.rechecks.get(`${batch.batch_id}|${id}`));
  const decided = records.filter(Boolean);
  const match = decided.filter((r) => r.verdict === "MATCH").length;
  const mismatch = decided.filter((r) => r.verdict === "MISMATCH").length;
  const deferred = decided.filter((r) => r.verdict === "DEFER").length;
  const pending = batch.members.length - decided.length;
  const adjudicated = match + mismatch;
  const consistency = adjudicated === 0 ? 0 : match / adjudicated;
  return {
    name: "RECHECK_CONSISTENCY",
    passed: pending === 0 && deferred === 0 && consistency + 1e-12 >= minConsistency,
    detail: {
      sample_size: batch.members.length,
      match, mismatch, deferred, pending,
      consistency: Math.round(consistency * 10000) / 10000,
      min_consistency: minConsistency,
    },
  };
}

function evaluateFreshnessGate(store, comparisons, requiredRegions) {
  const runningJobs = [...store.state.jobs.values()].filter((j) => j.status !== "COMPLETED");
  const stale = [];
  let carried_forward = 0;

  for (const c of comparisons) {
    const claim = store.state.claims.get(c.claim_id)?.claim;
    if (!claim || !requiredRegions.includes(claim.region)) continue;
    const current = store.currentMapping(claim.region);
    if (!current) {
      stale.push(c.claim_id);
      continue;
    }
    if (current.content_hash === c.deps.mapping) continue; // 已按最新映射重算

    // 结转判定：沿该地区修订链找到本比较所用修订，求其后所有修订变动编码的并集；
    // 若本事件费用行不命中其中任一编码，候选结果数学上不变，允许结转。
    const chain = store.state.mappingRevisions.get(claim.region) ?? [];
    const baseIndex = chain.findIndex((r) => r.content_hash === c.deps.mapping);
    if (baseIndex === -1) {
      stale.push(c.claim_id);
      continue;
    }
    const changedAfter = new Set();
    for (const r of chain.slice(baseIndex + 1)) {
      for (const code of r.changed_local_codes) changedAfter.add(code);
    }
    const touchesChanged = claim.lines.some((l) => changedAfter.has(l.local_code));
    if (touchesChanged) stale.push(c.claim_id);
    else carried_forward += 1;
  }

  return {
    name: "RESULTS_CURRENT",
    passed: runningJobs.length === 0 && stale.length === 0,
    detail: {
      running_jobs: runningJobs.map((j) => j.job_id),
      stale_claim_ids: stale,
      carried_forward_claims: carried_forward,
    },
  };
}

function evaluateRegionGate(store, catalogVersion, requiredRegions) {
  const details = requiredRegions.map((region) => {
    const signoff = store.state.signoffs.get(region);
    const current = store.currentMapping(region);
    const passed = Boolean(signoff) &&
      signoff.catalog_version === catalogVersion &&
      current !== null && signoff.mapping_revision === current.revision;
    return {
      region,
      passed,
      signed_catalog_version: signoff?.catalog_version ?? null,
      signed_mapping_revision: signoff?.mapping_revision ?? null,
      current_mapping_revision: current?.revision ?? null,
    };
  });
  return { name: "REGION_SIGNOFF", passed: details.every((d) => d.passed), detail: { regions: details } };
}
