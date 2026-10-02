// insurance_shadow_settlement 领域定义：事件词汇、信封校验与脱敏检查。
//
// 影子结算的全部产出都带 data_scope = "SHADOW" 标签；真实结算事件不得进入本日志，
// 影子事件也禁止被投递到真实结算或面向患者的查询汇槽（见 environment.js）。

export const DATA_SCOPE = "SHADOW";

// 冻结对象类型：国家/本地项目目录、地区映射、支付限制、样例费率。
export const ARTIFACT_TYPES = Object.freeze(["CATALOG", "MAPPING", "RESTRICTION", "RATE_TABLE"]);
export const SIDES = Object.freeze(["INCUMBENT", "CANDIDATE"]);

export const EVENT_KINDS = Object.freeze([
  "CATALOG_FROZEN",        // 冻结一份不可变对象（目录/映射/限制/费率）
  "CLAIM_INGESTED",        // 一条脱敏后的历史结算事件进入影子环境
  "MAPPING_REVISED",       // 专家补充/修订地区映射（快照式新版本，不覆盖旧版本）
  "REPLAY_STARTED",        // 重放作业开始（含分片计划与冻结版本引用）
  "REPLAY_PAUSED",         // 作业暂停
  "REPLAY_RESUMED",        // 作业恢复
  "REPLAY_CHECKPOINT",     // 分片游标推进
  "REPLAY_COMPLETED",      // 作业完成
  "COMPARISON_PRODUCED",   // 同一事件的现行 vs 候选比较结果（每事件仅一条有效）
  "SAMPLE_DRAWN",          // 确定性抽样批次
  "RECHECK_RECORDED",      // 抽样复核结论
  "REGION_SIGNED",         // 地区签署
  "RELEASE_QUALIFIED",     // 发布资格判定记录（只判定，不执行发布）
]);

export const REQUIRED_FIELDS = Object.freeze([
  "event_id",
  "kind",
  "occurred_at",
  "subject_id",
  "payload",
  "data_scope",
]);

// 各类事件 payload 的必备字段。
export const PAYLOAD_REQUIRED = Object.freeze({
  CATALOG_FROZEN: ["artifact_type", "side", "region", "version", "content_hash", "frozen_at", "effective_from", "content"],
  CLAIM_INGESTED: ["claim", "claim_hash"],
  MAPPING_REVISED: ["region", "revision", "content", "content_hash", "supersedes_revision", "changed_local_codes"],
  REPLAY_STARTED: ["job_id", "exercise_id", "kind", "shard_count", "plan", "refs"],
  REPLAY_PAUSED: ["job_id"],
  REPLAY_RESUMED: ["job_id"],
  REPLAY_CHECKPOINT: ["job_id", "shard", "cursor"],
  REPLAY_COMPLETED: ["job_id", "processed", "skipped"],
  COMPARISON_PRODUCED: ["job_id", "claim_id", "claim_hash", "idempotency_key", "supersedes_event_id", "incumbent", "candidate", "diffs", "deps"],
  SAMPLE_DRAWN: ["batch_id", "catalog_version", "fraction", "members", "seed_hash"],
  RECHECK_RECORDED: ["batch_id", "claim_id", "reviewer_token", "verdict"],
  REGION_SIGNED: ["region", "catalog_version", "mapping_revision", "signer_token"],
  RELEASE_QUALIFIED: ["catalog_version", "batch_id", "decision", "gate_results"],
});

// 差异三分类：编码缺失、组合规则冲突、支付范围变化。
export const DIFF_KINDS = Object.freeze({
  CODE_MISSING: "CODE_MISSING",   // 编码缺失
  RULE_CONFLICT: "RULE_CONFLICT", // 组合规则冲突
  SCOPE_CHANGE: "SCOPE_CHANGE",   // 支付范围变化
});

export function validateEvent(record) {
  const problems = [];
  for (const name of REQUIRED_FIELDS) if (!(name in record)) problems.push(`missing:${name}`);
  if (record.kind !== undefined && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  if (record.data_scope !== undefined && record.data_scope !== DATA_SCOPE) problems.push("data_scope");
  if (record.kind && PAYLOAD_REQUIRED[record.kind] && typeof record.payload === "object" && record.payload !== null) {
    for (const name of PAYLOAD_REQUIRED[record.kind]) {
      if (!(name in record.payload)) problems.push(`payload.${name}`);
    }
  }
  return problems;
}

// ---- 历史结算事件（去标识化）结构与 PII 拦截 -------------------------------

const CLAIM_ALLOWED_KEYS = new Set([
  "claim_id", "patient_token", "region", "setting", "service_date",
  "settled_at", "lines", "actual_settled", "currency",
]);
const LINE_ALLOWED_KEYS = new Set(["line_id", "local_code", "quantity"]);
const TOKEN_RE = /^(clm|pat|prov)-[0-9a-hjkmnpqrstvwxyz]{6,}$/;
const PII_PATTERNS = [
  ["身份证号", /(^|[^0-9])[0-9]{17}[0-9Xx]([^0-9]|$)/],
  ["手机号", /(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)/],
  ["银行卡号", /(^|[^0-9])[0-9]{16,19}([^0-9]|$)/],
  ["电子邮箱", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];
const FORBIDDEN_KEYS = /(name|姓名|id_?card|身份|phone|mobile|手机|bank|银行|address|地址|社保号|ssn)/i;

// 检查历史事件是否已脱敏、字段是否在白名单内。返回问题清单，[] 表示通过。
export function validateDesensitizedClaim(claim) {
  const problems = [];
  const walk = (value, path, allowedKeys, inArray) => {
    if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`, allowedKeys, true));
        return;
      }
      if (!inArray && allowedKeys) {
        for (const key of Object.keys(value)) {
          if (!allowedKeys.has(key)) problems.push(`${path}.${key}:字段不在白名单`);
          if (FORBIDDEN_KEYS.test(key)) problems.push(`${path}.${key}:疑似直接标识字段`);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.test(key)) problems.push(`${path}.${key}:疑似直接标识字段`);
        walk(child, `${path}.${key}`, null, false);
      }
      return;
    }
    if (typeof value === "string") {
      for (const [label, re] of PII_PATTERNS) {
        if (re.test(value)) problems.push(`${path}:疑似${label}`);
      }
    }
  };

  if (typeof claim !== "object" || claim === null) return ["claim:不是对象"];
  for (const key of ["claim_id", "patient_token", "region", "setting", "service_date", "lines"]) {
    if (!(key in claim)) problems.push(`claim.${key}:缺失`);
  }
  walk(claim, "claim", CLAIM_ALLOWED_KEYS, false);
  if (claim.claim_id && !TOKEN_RE.test(claim.claim_id)) problems.push("claim.claim_id:必须为脱敏令牌");
  if (claim.patient_token && !TOKEN_RE.test(claim.patient_token)) problems.push("claim.patient_token:必须为脱敏令牌");
  if (claim.lines) {
    if (!Array.isArray(claim.lines) || claim.lines.length === 0) problems.push("claim.lines:必须是非空数组");
    else for (const [i, line] of claim.lines.entries()) {
      for (const key of ["line_id", "local_code", "quantity"]) {
        if (!(key in line)) problems.push(`claim.lines[${i}].${key}:缺失`);
      }
      for (const key of Object.keys(line)) {
        if (!LINE_ALLOWED_KEYS.has(key)) problems.push(`claim.lines[${i}].${key}:字段不在白名单`);
      }
    }
  }
  if (claim.actual_settled && typeof claim.actual_settled.total_paid !== "number") {
    problems.push("claim.actual_settled.total_paid:必须为金额数字");
  }
  return problems;
}
