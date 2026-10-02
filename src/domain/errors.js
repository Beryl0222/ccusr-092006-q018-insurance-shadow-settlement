// 影子结算领域错误类型。所有错误都带稳定 code，便于 API 层映射状态码。

export class ShadowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ShadowError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class ValidationError extends ShadowError {
  constructor(message, details) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends ShadowError {
  constructor(message, details) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ShadowError {
  constructor(message, details) {
    super("CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

// 任何试图把影子数据带出获准环境、或把真实通道请求引入影子域的行为。
export class EnclaveViolation extends ShadowError {
  constructor(message, details) {
    super("ENCLAVE_VIOLATION", message, details);
    this.name = "EnclaveViolation";
  }
}

// 发布门槛（抽样复核 / 地区签署）未满足。
export class GateError extends ShadowError {
  constructor(message, details) {
    super("GATE_NOT_MET", message, details);
    this.name = "GateError";
  }
}
