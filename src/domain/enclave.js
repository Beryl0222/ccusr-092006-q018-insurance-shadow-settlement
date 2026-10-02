// 获准环境（enclave）安全边界。
//
// 影子结算的所有数据——候选目录、患者伪标识、内部样例费率、比较结果——
// 只能留在获准环境内。这里集中实现：
//   1. 历史事件脱敏白名单（拒绝任何真实身份字段进入）；
//   2. 影子域路径边界（真实结算库、面向患者查询的路径一律拒绝）；
//   3. shadow lane 标记与按角色脱敏的出域视图。
// 本模块刻意不提供任何"导出到真实结算"的函数——没有这个通道。

import path from "node:path";
import { ValidationError, EnclaveViolation } from "./errors.js";

// 真实结算与面向患者通道的路径特征。任何 I/O 目标命中即拒绝。
export const FORBIDDEN_PATH_PATTERNS = Object.freeze([
  /(^|[/\\])production([/\\]|$)/i,
  /(^|[/\\])prod([/\\]|$)/i,
  /(^|[/\\])live([/\\]|$)/i,
  /(^|[/\\])patient([-_/\\]|$)/i,
  /(^|[/\\])patientfacing([/\\]|$)/i,
  /(^|[/\\])settle([-_/\\]|$)/i, // 真实结算库 settle_db 等
  /(^|[/\\])claim-outbox([/\\]|$)/i, // 真实赔付出箱
]);

// HTTP 上永远不允许落在影子服务上的路径前缀。
export const FORBIDDEN_HTTP_PREFIXES = Object.freeze(["/patient", "/production", "/live", "/settle"]);

// 历史结算事件允许进入获准环境的字段白名单（其余字段一律剔除，敏感键直接拒绝）。
export const HISTORY_FIELD_WHITELIST = Object.freeze([
  "event_ref", // 来源系统的技术流水号（脱敏后）
  "subject_ref", // 伪标识（pseudo_ 开头）
  "region", // 就医地区
  "service_date", // 就医发生时点（重放时点基准）
  "ingested_at",
  "facility_level", // 机构等级，用于支付限制判定
  "lines", // 费用行
]);

export const LINE_FIELD_WHITELIST = Object.freeze(["line_ref", "local_code", "quantity", "charged_amount"]);

// 出现即说明上游没有脱敏，拒绝整批数据。
export const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  /(^|_)name$/,
  /id_?card|id_?no|identity_?no|cert_?no/,
  /phone|mobile|tel(_|$)/,
  /address|addr/,
  /birth|age/,
  /sex|gender/,
  /social|pension|employer/,
  /bank|card_?no|account/,
  /medical_?record|mrn|inpatient_?no/, // 真实病历号/住院号
  /real_?name|true_?name/,
]);

const PSEUDO_REF = /^pseudo_[0-9a-zA-Z]{6,}$/;
const CODE_RE = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/;
const REGION_RE = /^[0-9A-Za-z][0-9A-Za-z\-_]{0,15}$/;

function scanForbiddenKeys(value, location) {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key.toLowerCase()))) {
      throw new EnclaveViolation("历史数据包含未脱敏字段，整批拒绝进入获准环境", {
        field: `${location}${key}`,
      });
    }
    if (typeof value[key] === "string" && value[key].length > 128) {
      throw new ValidationError("字符串字段过长，疑似夹带自由文本/病历内容", { field: `${location}${key}` });
    }
    scanForbiddenKeys(value[key], `${location}${key}.`);
  }
}

// 脱敏与结构化校验：只保留白名单字段，返回获准环境内的规范历史事件。
export function sanitizeHistoryEvent(input) {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("历史事件必须是对象");
  }
  scanForbiddenKeys(input, "");

  const missing = ["event_ref", "subject_ref", "region", "service_date", "lines"].filter((k) => !(k in input));
  if (missing.length) throw new ValidationError("历史事件缺少必填字段", { missing });

  if (!PSEUDO_REF.test(input.subject_ref)) {
    throw new EnclaveViolation("subject_ref 必须是 pseudo_ 开头的伪标识，真实患者标识不得进入获准环境", {
      subject_ref: String(input.subject_ref).slice(0, 24),
    });
  }
  if (!REGION_RE.test(input.region)) throw new ValidationError("地区代码格式不合法", { region: input.region });
  const serviceDate = Date.parse(input.service_date);
  if (Number.isNaN(serviceDate)) throw new ValidationError("service_date 不是合法时间", { value: input.service_date });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError("历史事件至少包含一条费用行");
  }

  const lines = input.lines.map((line, i) => {
    if (line === null || typeof line !== "object") throw new ValidationError("费用行必须是对象", { index: i });
    const out = {};
    for (const k of LINE_FIELD_WHITELIST) if (k in line) out[k] = line[k];
    if (!CODE_RE.test(out.local_code)) throw new ValidationError("本地项目编码格式不合法", { index: i });
    out.quantity = Number(out.quantity);
    out.charged_amount = Number(out.charged_amount);
    if (!(out.quantity > 0) || !(out.charged_amount >= 0)) {
      throw new ValidationError("数量/金额不合法", { index: i });
    }
    return out;
  });

  const event = {
    event_ref: String(input.event_ref),
    subject_ref: input.subject_ref,
    region: input.region,
    service_date: new Date(serviceDate).toISOString(),
    facility_level: input.facility_level ?? "standard",
    lines,
  };
  return Object.freeze(event);
}

// 存储路径必须落在影子根目录内，且不得伪装成真实结算/患者通道。
export function assertWithinEnclave(targetPath, shadowRoot) {
  const resolvedRoot = path.resolve(shadowRoot);
  const resolved = path.resolve(resolvedRoot, targetPath);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new EnclaveViolation("路径越出获准环境根目录", { path: targetPath });
  }
  if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(rel) || re.test(resolved))) {
    throw new EnclaveViolation("影子 I/O 不得指向真实结算或面向患者的路径", { path: rel });
  }
  return resolved;
}

export function assertShadowHttpPath(urlPathname) {
  for (const prefix of FORBIDDEN_HTTP_PREFIXES) {
    if (urlPathname === prefix || urlPathname.startsWith(`${prefix}/`)) {
      throw new EnclaveViolation("影子服务不承载真实结算或面向患者的路径", { path: urlPathname });
    }
  }
}

const SHADOW_MARK = Symbol.for("shadow.lane.v1");

// 给内存对象盖上 shadow lane 章；服务层只接受盖章对象写出，防止误用真实数据结构。
// 已冻结的不可变领域对象（快照）无法再定义属性——它们本身不可变、只在获准环境内
// 构造，视为天然处于影子域，直接返回。
export function markShadowLane(value) {
  if (value && typeof value === "object" && Object.isExtensible(value)) {
    Object.defineProperty(value, SHADOW_MARK, { value: true, enumerable: false });
  }
  return value;
}

export function isShadowLane(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value[SHADOW_MARK] === true || !Object.isExtensible(value)),
  );
}

// 出域视图：内部样例费率只对获准环境内的分析/复核角色可见；
// patient 角色直接拒绝——影子结果永远不进面向患者的查询。
export function redactForRole(view, role) {
  if (role === "patient" || role === "patient-facing") {
    throw new EnclaveViolation("影子比较结果不得进入面向患者的查询结果");
  }
  if (role === "analyst" || role === "reviewer" || role === "admin" || role === "system") return view;
  const clone = structuredClone(view);
  const strip = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(strip);
      return;
    }
    delete node.rate;
    delete node.sample_rate;
    delete node.rate_basis;
    for (const v of Object.values(node)) strip(v);
  };
  strip(clone);
  return clone;
}
