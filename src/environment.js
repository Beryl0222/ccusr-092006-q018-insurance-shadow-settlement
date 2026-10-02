// 获准环境与数据外泄边界。
//
// 多轮演练期间，候选目录、患者标识与内部费率只能留在获准环境中：
//   1. 所有读写都必须显式经过 EnvironmentBoundary，未获准环境一律拒绝；
//   2. 影子事件只允许写入影子汇槽，真实结算与面向患者查询的汇槽硬编码禁入；
//   3. 向获准环境之外导出时，患者标识被令牌替换、内部费率字段被剥离。

import { createHash } from "node:crypto";

export const SINKS = Object.freeze({
  SHADOW_EVENT_LOG: "shadow-event-log",
  SHADOW_READ_MODEL: "shadow-read-model",
  PRODUCTION_SETTLEMENT: "production-settlement",
  PATIENT_QUERY: "patient-facing-query",
});

// 真实结算 / 面向患者查询汇槽：影子数据任何情况下都不得进入。
const FORBIDDEN_SINKS = new Set([SINKS.PRODUCTION_SETTLEMENT, SINKS.PATIENT_QUERY]);
const ALLOWED_SINKS = new Set([SINKS.SHADOW_EVENT_LOG, SINKS.SHADOW_READ_MODEL]);

export class EnvironmentBoundary {
  // approvedEnvs: 获准环境标识清单；allowedRoots: 影子数据允许落盘的根目录前缀。
  constructor({ envId, approvedEnvIds, allowedRoots }) {
    this.envId = envId;
    this.approved = approvedEnvIds.includes(envId);
    this.allowedRoots = allowedRoots.map((p) => p.replace(/\/?$/, "/"));
  }

  assertApproved() {
    if (!this.approved) {
      throw new Error(`环境 ${this.envId} 未获准承载影子演练数据，操作被拒绝`);
    }
  }

  assertSink(sink) {
    this.assertApproved();
    if (FORBIDDEN_SINKS.has(sink)) {
      throw new Error(`影子数据禁止写入 ${sink}（真实结算/患者查询汇槽硬隔离）`);
    }
    if (!ALLOWED_SINKS.has(sink)) throw new Error(`未知汇槽:${sink}`);
  }

  assertPathInside(path) {
    this.assertApproved();
    const normalized = path.replace(/\/?$/, "/");
    if (!this.allowedRoots.some((root) => normalized.startsWith(root))) {
      throw new Error(`路径 ${path} 不在获准根目录内，影子数据不得落盘到此处`);
    }
  }
}

// 需要剥离的内部费率字段（候选/现行均剥离，费率是演练内部信息）。
const RATE_KEYS = new Set(["unit_rate", "total_charged", "line_charged"]);

function stripRates(value) {
  if (Array.isArray(value)) return value.map(stripRates);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !RATE_KEYS.has(key))
        .map(([key, child]) => [key, stripRates(child)]),
    );
  }
  return value;
}

// 向获准环境之外导出：患者标识用不可逆令牌替换，内部费率整段剥离。
// pepper 由获准环境保管，不出现在导出物中。
export function redactForExport(records, { pepper, includePatient = false }) {
  const tokenOf = (patientToken) =>
    "ext-" + createHash("sha256").update(`${pepper}|${patientToken}`).digest("hex").slice(0, 16);
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        if (!includePatient && key === "patient_token") {
          out.patient_ref = typeof child === "string" ? tokenOf(child) : null;
        } else if (RATE_KEYS.has(key)) {
          continue;
        } else if (key === "content" && value.artifact_type === "RATE_TABLE") {
          out[key] = { redacted: true }; // 费率表内容不得出环境
        } else {
          out[key] = walk(child);
        }
      }
      return out;
    }
    return value;
  };
  return (Array.isArray(records) ? records : [records]).map(walk);
}
