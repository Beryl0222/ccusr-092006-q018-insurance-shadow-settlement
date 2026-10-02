// 测试引导：在获准环境的临时影子目录中装配一套完整演练世界。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentBoundary, SINKS } from "../src/environment.js";
import { FreezeRegistry } from "../src/freeze.js";
import { ShadowEventStore } from "../src/store.js";
import { ShadowSettlementService } from "../src/service.js";
import {
  REGIONS, REGION_A, REGION_B, NATIONAL,
  incumbentCatalog, incumbentRestriction, incumbentRates,
  candidateCatalog, candidateRestriction, candidateRates,
} from "../examples/fixtures.js";

export function approvedBoundary() {
  const root = mkdtempSync(join(tmpdir(), "shadow-settlement-"));
  return {
    root,
    boundary: new EnvironmentBoundary({
      envId: "env-approved-test",
      approvedEnvIds: ["env-approved-test"],
      allowedRoots: [root],
    }),
  };
}

export async function buildWorld({ clock } = {}) {
  const { root, boundary } = approvedBoundary();
  const registry = new FreezeRegistry();
  const store = ShadowEventStore.open(boundary, join(root, "shadow-events.log"), clock);
  const svc = new ShadowSettlementService(store, registry, clock ?? (() => "2026-09-01T08:00:00+08:00"));

  const frozen = {};
  const baseTime = "2026-01-01T00:00:00+08:00";
  for (const region of REGIONS) {
    frozen[`inc_catalog_${region}`] = await svc.freeze({
      artifact_type: "CATALOG", side: "INCUMBENT", region, version: `local-2025-${region}`,
      content: incumbentCatalog(region), frozen_at: baseTime, effective_from: "2025-01-01T00:00:00+08:00",
    });
    frozen[`inc_restriction_${region}`] = await svc.freeze({
      artifact_type: "RESTRICTION", side: "INCUMBENT", region, version: `local-res-2025-${region}`,
      content: incumbentRestriction(region), frozen_at: baseTime, effective_from: "2025-01-01T00:00:00+08:00",
    });
    frozen[`inc_rate_${region}`] = await svc.freeze({
      artifact_type: "RATE_TABLE", side: "INCUMBENT", region, version: `local-rate-2025-${region}`,
      content: incumbentRates(region), frozen_at: baseTime, effective_from: "2025-01-01T00:00:00+08:00",
    });
  }
  frozen.cand_catalog = await svc.freeze({
    artifact_type: "CATALOG", side: "CANDIDATE", region: NATIONAL, version: "national-v1",
    content: candidateCatalog(), frozen_at: "2026-08-01T00:00:00+08:00",
    effective_from: "2026-08-01T00:00:00+08:00",
  });
  frozen.cand_restriction = await svc.freeze({
    artifact_type: "RESTRICTION", side: "CANDIDATE", region: NATIONAL, version: "national-res-v1",
    content: candidateRestriction(), frozen_at: "2026-08-01T00:00:00+08:00",
    effective_from: "2026-08-01T00:00:00+08:00",
  });
  frozen.cand_rate = await svc.freeze({
    artifact_type: "RATE_TABLE", side: "CANDIDATE", region: NATIONAL, version: "national-rate-v1",
    content: candidateRates(), frozen_at: "2026-08-01T00:00:00+08:00",
    effective_from: "2026-08-01T00:00:00+08:00",
  });

  return { root, boundary, registry, store, svc, frozen, SINKS, REGION_A, REGION_B };
}

export async function ingestAll(world, claims) {
  for (const claim of claims) await world.svc.ingestClaim(claim);
}

export function refsWith(world, mappingHashesByRegion) {
  return {
    incumbent: { region: "AUTO" },
    candidate: {
      region: "AUTO",
      catalog: world.frozen.cand_catalog.content_hash,
      restriction: world.frozen.cand_restriction.content_hash,
      rate: world.frozen.cand_rate.content_hash,
      mapping: mappingHashesByRegion,
    },
  };
}
