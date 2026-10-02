import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeHistoryEvent,
  assertWithinEnclave,
  assertShadowHttpPath,
  redactForRole,
  isShadowLane,
  markShadowLane,
} from "../src/domain/enclave.js";
import { EnclaveViolation, ValidationError } from "../src/domain/errors.js";

const baseEvent = () => ({
  event_ref: "evt-1",
  subject_ref: "pseudo_ab12cd",
  region: "R1",
  service_date: "2026-03-01T10:00:00Z",
  facility_level: "t3",
  lines: [{ line_ref: "l1", local_code: "L01", quantity: 2, charged_amount: 100 }],
});

test("脱敏：只保留白名单字段", () => {
  const out = sanitizeHistoryEvent({ ...baseEvent(), extra_junk: "x", operator_note: "y" });
  assert.deepEqual(Object.keys(out).sort(), [
    "event_ref", "facility_level", "lines", "region", "service_date", "subject_ref",
  ]);
  assert.deepEqual(Object.keys(out.lines[0]).sort(), [
    "charged_amount", "line_ref", "local_code", "quantity",
  ]);
});

test("脱敏：真实患者标识一律拒绝", () => {
  for (const bad of ["110101199001011234", "PATIENT-001", "pseudo_x", "pseudo_", 42]) {
    assert.throws(
      () => sanitizeHistoryEvent({ ...baseEvent(), subject_ref: bad }),
      EnclaveViolation,
    );
  }
});

test("脱敏：夹带身份/联系方式字段整批拒绝", () => {
  assert.throws(() => sanitizeHistoryEvent({ ...baseEvent(), real_name: "张三" }), EnclaveViolation);
  assert.throws(() => sanitizeHistoryEvent({ ...baseEvent(), mobile: "13800000000" }), EnclaveViolation);
  assert.throws(() => sanitizeHistoryEvent({ ...baseEvent(), id_card_no: "x" }), EnclaveViolation);
  assert.throws(
    () => sanitizeHistoryEvent({ ...baseEvent(), lines: [{ ...baseEvent().lines[0], inpatient_no: "Z99" }] }),
    EnclaveViolation,
  );
});

test("脱敏：非法时间/金额/空费用行被拒", () => {
  assert.throws(() => sanitizeHistoryEvent({ ...baseEvent(), service_date: "not-a-date" }), ValidationError);
  assert.throws(
    () => sanitizeHistoryEvent({ ...baseEvent(), lines: [{ ...baseEvent().lines[0], quantity: 0 }] }),
    ValidationError,
  );
  assert.throws(() => sanitizeHistoryEvent({ ...baseEvent(), lines: [] }), ValidationError);
});

test("路径边界：禁止越权与伪装成真实/患者通道", () => {
  assert.throws(() => assertWithinEnclave("../../etc/passwd", "/tmp/shadow-root"), EnclaveViolation);
  assert.throws(() => assertWithinEnclave("/var/settle_db/x", "/tmp/shadow-root"), EnclaveViolation);
  assert.throws(() => assertWithinEnclave("production/settle.db", "/tmp/shadow-root"), EnclaveViolation);
  assert.throws(() => assertWithinEnclave("patient-facing/query.json", "/tmp/shadow-root"), EnclaveViolation);
  assert.throws(() => assertWithinEnclave("live/claims", "/tmp/shadow-root"), EnclaveViolation);
  // 合法影子路径放行
  assert.ok(assertWithinEnclave("ledger/events.jsonl", "/tmp/shadow-root").endsWith("ledger/events.jsonl"));
});

test("HTTP 边界：患者/真实通道路径在影子服务上一律拒绝", () => {
  for (const p of ["/patient/claims/P1", "/production/settle", "/live/status", "/settle/outbox"]) {
    assert.throws(() => assertShadowHttpPath(p), EnclaveViolation);
  }
  assert.doesNotThrow(() => assertShadowHttpPath("/shadow/health"));
});

test("出域视图：患者角色拒绝、观察者剥离费率、分析员可见", () => {
  const view = markShadowLane({ lines: [{ code: "N01", rate: 40, amount: 80, basis: "x" }], sample_rate: 40 });
  assert.throws(() => redactForRole(view, "patient"), EnclaveViolation);
  const observer = redactForRole(view, "observer");
  assert.equal(observer.lines[0].rate, undefined);
  assert.equal(observer.sample_rate, undefined);
  assert.equal(observer.lines[0].amount, 80); // 金额结论保留
  const analyst = redactForRole(view, "analyst");
  assert.equal(analyst.lines[0].rate, 40);
  assert.equal(isShadowLane(view), true);
});
