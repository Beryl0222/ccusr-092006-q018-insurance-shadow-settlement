#!/usr/bin/env node
// 影子结算后端启动入口：只绑定 loopback，数据根目录必须位于获准环境。
//
//   SHADOW_HOME=/path/to/enclave-root node bin/serve.js --port 8088
//
// 该进程不连接任何真实结算/患者系统；账本即唯一存储。

import { Ledger } from "../src/store/ledger.js";
import { ShadowService } from "../src/service/ShadowService.js";
import { createShadowServer } from "../src/server/http.js";

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i++) {
  const token = argv[i].replace(/^--/, "");
  const eq = token.indexOf("=");
  if (eq >= 0) {
    args.set(token.slice(0, eq), token.slice(eq + 1));
  } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
    args.set(token, argv[++i]);
  } else {
    args.set(token, true);
  }
}

const home = args.get("home") ?? process.env.SHADOW_HOME;
if (!home) {
  console.error("必须指定 --home 或 SHADOW_HOME（获准环境数据根目录）");
  process.exit(2);
}
const port = Number(args.get("port") ?? process.env.SHADOW_PORT ?? 8088);
const host = "127.0.0.1"; // 硬编码 loopback：影子服务不对外监听。

const ledger = new Ledger(home).ensure();
const service = new ShadowService(ledger);
const server = createShadowServer(service);

server.listen(port, host, () => {
  console.log(`[shadow] 影子结算后端仅监听 http://${host}:${port} (lane=shadow, home=${home})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[shadow] 收到 ${sig}，停止接收新请求（账本已 fsync，可随时恢复）`);
    server.close(() => process.exit(0));
  });
}
