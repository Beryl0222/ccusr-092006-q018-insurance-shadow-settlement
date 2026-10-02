// 虚构演练夹具：两家虚构地区、本地旧目录、国家候选目录、支付限制、样例费率、
// 地区映射两版修订，以及 6 条完全虚构的脱敏历史结算事件。
// 全部编码、金额、令牌均为演练数据，不含任何真实个人信息。

export const REGION_A = "REGION_A";
export const REGION_B = "REGION_B";
export const REGIONS = [REGION_A, REGION_B];
export const NATIONAL = "NATIONAL";

const ALL_SETTINGS = ["OPD", "IPD"];

// ---- 现行侧：本地旧项目（各地区目录结构一致，费率不同） --------------------

export function incumbentCatalog(region) {
  const categoryOf = { L001: "甲", L002: "甲", L003: "乙", L004: "乙", L005: "丙", L006: "甲", L009: "乙" };
  const items = {};
  for (const code of ["L001", "L002", "L003", "L004", "L005", "L006", "L009"]) {
    items[code] = { name: `本地项目${code}`, pay_category: categoryOf[code], payable: true, settings: ALL_SETTINGS };
  }
  return { region, items };
}

export function incumbentRestriction(region) {
  return { region, restrictions: {} }; // 旧目录侧本批规则均在项目层面，无附加限制
}

const INCUMBENT_RATES = {
  REGION_A: { L001: 20, L002: 120, L003: 50, L004: 40, L005: 80, L006: 10, L009: 30 },
  REGION_B: { L001: 18, L002: 115, L003: 48, L004: 42, L005: 75, L006: 9, L009: 28 },
};

export function incumbentRates(region) {
  return { region, rates: INCUMBENT_RATES[region] };
}

// ---- 候选侧：首批国家医疗服务项目目录 --------------------------------------

export function candidateCatalog() {
  return {
    items: {
      N001: { name: "国家项目N001", pay_category: "甲", payable: true, settings: ALL_SETTINGS },
      N002: { name: "国家项目N002", pay_category: "甲", payable: true, settings: ALL_SETTINGS },
      N003: {
        name: "国家项目N003", pay_category: "乙", payable: true, settings: ["OPD"],
        rules: [{ rule_id: "NR-003-EXCL", type: "EXCLUSIVE_WITH", codes: ["N004"],
          reason: "N003 与 N004 互斥，同次就医不得同时支付" }],
      },
      N004: { name: "国家项目N004", pay_category: "乙", payable: true, settings: ["OPD"] },
      N005: { name: "国家项目N005", pay_category: "丙", payable: true, settings: ALL_SETTINGS },
      N006: { name: "国家项目N006", pay_category: "甲", payable: true, settings: ["OPD"] },
      N009: { name: "国家项目N009", pay_category: "乙", payable: true, settings: ALL_SETTINGS },
    },
  };
}

export function candidateRestriction() {
  return {
    restrictions: {
      N005: [{ rule_id: "NR-005-EXC", type: "EXCLUDED", reason: "国家目录明确 N005 不予支付" }],
      N006: [{ rule_id: "NR-006-QMAX", type: "QUANTITY_MAX", max: 2, reason: "N006 单次就医限支付 2 个单位" }],
    },
  };
}

export function candidateRates() {
  return { rates: { N001: 22, N002: 130, N003: 55, N004: 38, N005: 60, N006: 12, N009: 33 } };
}

// ---- 地区映射：修订 1 缺 L009；专家补充后修订 2 补齐 ------------------------

export function mappingRevision1() {
  return {
    entries: {
      L001: { national_code: "N001" },
      L002: { national_code: "N002" },
      L003: { national_code: "N003" },
      L004: { national_code: "N004" },
      L005: { national_code: "N005" },
      L006: { national_code: "N006" },
    },
  };
}

export function mappingRevision2() {
  return {
    entries: {
      L001: { national_code: "N001" },
      L002: { national_code: "N002" },
      L003: { national_code: "N003" },
      L004: { national_code: "N004" },
      L005: { national_code: "N005" },
      L006: { national_code: "N006" },
      L009: { national_code: "N009" },
    },
  };
}

// ---- 脱敏历史结算事件 -------------------------------------------------------

export function historicalClaims() {
  return [
    {
      claim_id: "clm-aaaaaa", patient_token: "pat-aaaaaa", region: REGION_A, setting: "OPD",
      service_date: "2026-03-10T09:30:00+08:00", settled_at: "2026-03-12T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L001", quantity: 1 }, { line_id: "ln-2", local_code: "L009", quantity: 1 }],
    },
    {
      claim_id: "clm-bbbbbb", patient_token: "pat-bbbbbb", region: REGION_A, setting: "OPD",
      service_date: "2026-04-02T14:00:00+08:00", settled_at: "2026-04-03T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L003", quantity: 1 }, { line_id: "ln-2", local_code: "L004", quantity: 1 }],
    },
    {
      claim_id: "clm-cccccc", patient_token: "pat-cccccc", region: REGION_A, setting: "IPD",
      service_date: "2026-05-20T08:15:00+08:00", settled_at: "2026-05-22T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L005", quantity: 1 }],
    },
    {
      claim_id: "clm-dddddd", patient_token: "pat-dddddd", region: REGION_A, setting: "OPD",
      service_date: "2026-06-15T11:45:00+08:00", settled_at: "2026-06-16T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L006", quantity: 5 }],
    },
    {
      claim_id: "clm-eeeeee", patient_token: "pat-eeeeee", region: REGION_A, setting: "OPD",
      service_date: "2026-02-01T09:00:00+08:00", settled_at: "2026-02-02T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L001", quantity: 1 }, { line_id: "ln-2", local_code: "L002", quantity: 1 }],
    },
    {
      claim_id: "clm-ffffff", patient_token: "pat-ffffff", region: REGION_B, setting: "OPD",
      service_date: "2026-03-11T10:00:00+08:00", settled_at: "2026-03-12T10:00:00+08:00",
      currency: "CNY",
      lines: [{ line_id: "ln-1", local_code: "L001", quantity: 1 }, { line_id: "ln-2", local_code: "L009", quantity: 1 }],
    },
  ];
}
