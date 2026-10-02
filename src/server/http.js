// 影子结算 HTTP 后端。
//
// 边界约定（务必保持）：
//   - 只监听 loopback（见 bin/serve.js），不对外暴露；
//   - 只承载 /shadow 前缀；/patient、/production、/live、/settle 一律 403；
//   - 每个响应带 x-shadow-lane: 1 与 Cache-Control: no-store；
//   - 面向患者角色（x-shadow-role: patient）直接拒绝；内部费率按角色脱敏；
//   - 本服务没有任何把候选结果写入真实结算库或患者查询库的路由。

import http from "node:http";
import { Buffer } from "node:buffer";
import { ShadowError } from "../domain/errors.js";
import { assertShadowHttpPath, redactForRole, markShadowLane } from "../domain/enclave.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PRIVILEGED_ROLES = new Set(["analyst", "reviewer", "admin", "system"]);

const STATUS_BY_CODE = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GATE_NOT_MET: 422,
  ENCLAVE_VIOLATION: 403,
};

export class HttpError extends ShadowError {
  constructor(status, message, details) {
    super("HTTP_ERROR", message, details);
    this.status = status;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "请求体超过获准环境影子接口上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 极简确定性路由：[method, pattern(named :seg), handler]。
function compile(method, pathPattern, handler) {
  const names = [];
  const regex = new RegExp(
    `^${pathPattern.replace(/:[^/]+/g, (m) => {
      names.push(m.slice(1));
      return "([^/]+)";
    })}$`,
  );
  return { method, regex, names, handler };
}

export function createShadowServer(service) {
  const routes = [
    compile("GET", "/shadow/health", () => ({ ok: true, lane: "shadow" })),

    compile("POST", "/shadow/history/ingest", async (ctx) =>
      service.ingestHistory(Array.isArray(ctx.body) ? ctx.body : ctx.body.events ?? [], { by: ctx.actor })),
    compile("GET", "/shadow/history", () => ({ events: service.listHistory() })),

    compile("POST", "/shadow/snapshots/freeze", (ctx) =>
      service.freezeCatalog(ctx.body, { by: ctx.actor })),
    compile("GET", "/shadow/snapshots", () => ({ snapshots: service.listSnapshots() })),
    compile("GET", "/shadow/snapshots/:id", (ctx) => ({ snapshot: service.getSnapshot(ctx.params.id) })),
    compile("POST", "/shadow/snapshots/:id/revise", (ctx) =>
      service.reviseMappings(
        ctx.params.id,
        { add: ctx.body.add ?? [], retire: ctx.body.retire ?? [], note: ctx.body.note ?? null },
        { by: ctx.actor },
      )),

    compile("POST", "/shadow/jobs", (ctx) => ({
      job: service.createJob({
        snapshot_id: ctx.body.snapshot_id,
        mode: ctx.body.mode ?? "FULL",
        shard_count: ctx.body.shard_count ?? 4,
        request_id: ctx.body.request_id ?? "default",
      }).job,
    })),
    compile("GET", "/shadow/jobs", () => ({ jobs: service.listJobs() })),
    compile("GET", "/shadow/jobs/:id", (ctx) => ({ job: service.getJob(ctx.params.id) })),
    compile("POST", "/shadow/jobs/:id/pause", (ctx) => service.pauseJob(ctx.params.id)),
    compile("POST", "/shadow/jobs/:id/resume", (ctx) => service.resumeJob(ctx.params.id)),
    compile("POST", "/shadow/jobs/:id/shards/:idx/lease", (ctx) =>
      service.leaseShard(ctx.params.id, {
        owner: ctx.body.owner ?? ctx.actor,
        lease_ms: ctx.body.lease_ms,
        shard: ctx.params.idx,
      })),
    compile("POST", "/shadow/jobs/:id/shards/:idx/run", (ctx) =>
      service.runShard(ctx.params.id, Number(ctx.params.idx), {
        owner: ctx.body.owner ?? ctx.actor,
        max_items: ctx.body.max_items,
        time_budget_ms: ctx.body.time_budget_ms,
      })),

    compile("GET", "/shadow/snapshots/:id/summary", (ctx) => service.diffSummary(ctx.params.id)),
    compile("GET", "/shadow/snapshots/:id/drills/:category", (ctx) =>
      service.diffDrill(ctx.params.id, ctx.params.category, { limit: ctx.query.limit ? Number(ctx.query.limit) : 200 })),
    compile("GET", "/shadow/snapshots/:id/comparisons/:eventRef", (ctx) =>
      service.resolveComparison(ctx.params.id, ctx.params.eventRef)),
    compile("GET", "/shadow/snapshots/:id/basis", (ctx) => {
      if (!ctx.query.event_ref || !ctx.query.line_ref) {
        throw new HttpError(400, "basis 下钻需要 event_ref 与 line_ref 查询参数");
      }
      return service.ruleBasis(ctx.params.id, ctx.query.event_ref, ctx.query.line_ref);
    }),

    compile("POST", "/shadow/snapshots/:id/review-plans", (ctx) =>
      service.createReviewPlan(ctx.params.id, { seed: ctx.body.seed ?? null, strata: ctx.body.strata })),
    compile("GET", "/shadow/review-plans/:planId/gate", (ctx) =>
      service.reviewGate(ctx.params.planId, {
        max_disagreement_rate: ctx.query.max_disagreement_rate ? Number(ctx.query.max_disagreement_rate) : 0.05,
      })),
    compile("POST", "/shadow/review-plans/:planId/items/:itemId/review", (ctx) =>
      service.recordReview(ctx.params.planId, ctx.params.itemId, {
        verdict: ctx.body.verdict,
        by: ctx.actor,
        note: ctx.body.note ?? null,
      })),

    compile("POST", "/shadow/regions/sign", (ctx) =>
      service.signRegion({
        region: ctx.body.region,
        snapshot_id: ctx.body.snapshot_id,
        signer: ctx.actor,
      })),

    // 发布：只计算资格 / 颁发"获准环境内资格证书"，绝无下发真实结算的路由。
    compile("POST", "/shadow/releases/check", (ctx) => {
      const campaign = service.createReleaseCampaign({ name: ctx.body.name, members: ctx.body.members }).campaign;
      return { campaign, eligibility: service.releaseEligibility(campaign) };
    }),
    compile("POST", "/shadow/releases/issue", (ctx) => {
      const campaign = service.createReleaseCampaign({ name: ctx.body.name, members: ctx.body.members }).campaign;
      return service.issueRelease(campaign);
    }),
  ];

  const server = http.createServer(async (req, res) => {
    setShadowHeaders(res);
    try {
      const url = new URL(req.url, "http://shadow.local");
      // 路径边界：真实结算 / 患者通道路径在影子服务上永远 403。
      assertShadowHttpPath(url.pathname);
      if (!url.pathname.startsWith("/shadow/") && url.pathname !== "/shadow/health") {
        throw new HttpError(404, "影子服务只提供 /shadow 前缀下的接口");
      }
      const route = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
      if (!route) throw new HttpError(404, "影子接口不存在", { path: url.pathname });

      const match = url.pathname.match(route.regex);
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const role = req.headers["x-shadow-role"] ?? "observer";
      const actor = String(req.headers["x-shadow-actor"] ?? role);
      const ctx = { params, body, query: Object.fromEntries(url.searchParams), role, actor };

      const result = await route.handler(ctx);
      // 出域脱敏：patient 角色直接抛 ENCLAVE_VIOLATION；非授权角色剥离内部费率。
      const view = redactForRole(markShadowLane({ data: result ?? null }), PRIVILEGED_ROLES.has(role) ? "analyst" : role);
      sendJson(res, 200, view);
    } catch (error) {
      sendError(res, error);
    }
  });

  return server;
}

function setShadowHeaders(res) {
  res.setHeader("X-Shadow-Lane", "1");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError
    ? error.status
    : STATUS_BY_CODE[error.code] ?? 500;
  if (status === 500) {
    // 500 的细节不外泄；enclave 相关错误则必须显式拒绝。
    // eslint-disable-next-line no-console
    console.error("[shadow] internal error:", error);
  }
  sendJson(res, status, {
    error: {
      code: error.code ?? "INTERNAL",
      message: status === 500 ? "影子服务内部错误" : error.message,
      details: error.details,
      shadow_lane: true,
    },
  });
}
