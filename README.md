# 医保目录影子结算后端

首批**国家医疗服务项目目录**正式启用前的影子结算系统。经办机构用它对同一批**脱敏历史结算事件**
按**就医发生时点**分别用「本地旧项目（现行）」和「国家项目（候选）」各算一次，量化：

- **编码缺失**（`CODE_MISSING`）——国家目录中无对应项目或地区映射缺失；
- **组合规则冲突**（`RULE_CONFLICT`）——多映射歧义、候选国家项目互斥共现；
- **支付范围变化**（`SCOPE_CHANGE`）——纳入 ⇄ 排除；
- **金额/计费数量变化**（`AMOUNT_CHANGE`）——样例费率、数量上限导致的支付差异（费率缺失标记不可比）。

现行结果与候选结果**分别保存**，差异可从汇总逐级下钻到具体规则/费率/映射依据。
整个演练**不触碰原支付状态**：系统只读取历史、只在获准环境（enclave）内写入影子结论，
**没有任何把候选结果写入真实结算或面向患者查询的通道**。

## 快速开始

```bash
npm test     # 47 个测试（领域、服务、门槛、HTTP 边界、端到端）
npm run demo # 全流程演示：冻结→分片重放→下钻→专家修订→增量重算→复核→签署→发证
npm run serve -- --home ./.shadow-data --port 8088   # 仅监听 127.0.0.1
```

## 核心设计

### 1. 不可变冻结快照（内容寻址）

一次冻结整体固定五要素（`src/domain/catalog.js`）：

| 要素 | 校验 |
| --- | --- |
| 国家目录版本 `national_catalog` | 编码唯一、格式合法 |
| 本地旧目录版本 `local_catalog` | 同上 |
| 地区映射 `mappings` | 本地码/国家码必须在对应目录内；一对多映射保留并在重放时判为歧义冲突 |
| 支付限制 `restrictions` | `scope`（纳入/排除）、`mutually_exclusive`（互斥组合）、`max_quantity`（数量上限）；支持机构等级与生效区间 |
| 样例费率 `sample_rates` | 同编码+机构等级的生效区间（半开）不得重叠 |

快照经规范化哈希得到 `snapshot_id = snap_<content_hash 前12位>`：**相同内容必然同 ID，
任何一处替换都会改变指纹**。冻结阶段拒绝重叠区间，保证按就医时点能唯一定位规则与费率。

### 2. 按就医发生时点的双轨纯函数重放

`replayEvent(snapshot, event)`（`src/domain/replay.js`）是纯函数：以 `service_date`
选择规则/费率版本，以 `facility_level` 匹配机构等级；`comparison_id` 由
`(snapshot_id, event_ref, service_date)` 派生。因此：

- 现行结果 `current_result` 与候选结果 `candidate_result` 分别保存；
- 同快照同事件重复执行得到完全相同的结论——分片、重试、重启续跑都安全；
- 历史事件只读，引擎不提供回写真实支付状态的出口。

每条差异都带 `rule_basis`：规则 ID、费率 ID、映射 ID 及其定义原文与 `basis` 说明。

### 3. 分片、暂停、恢复与幂等

- 历史事件摄入先过**脱敏白名单**（见安全边界），按内容哈希去重；同 `event_ref`
  内容不同直接拒绝；同一事件重复进入只保留一次。
- 作业 `FULL`（基线全量）/ `INCREMENTAL`（修订增量），事件按内容哈希确定性分配到分片，
  `request_id` 相同的重复建作业请求返回同一作业（重试安全）。
- 工作者以**租约**（lease + epoch）领取分片：协作式响应暂停、时间预算与租约到期；
  游标以检查点事件落盘（每 10 条），进程重启后从账本重放状态，租约过期即可被其他工作者接管。
- **纪元栅栏（fencing）**：租约易主后，旧持有者的任何检查点/处理写入都被拒绝。
- 比较记录按 `(snapshot_id, event_ref)` 唯一存储：即使多个作业重复处理同一事件，
  `CLAIM_REPLAYED` 事件幂等，状态中只有一份有效比较。

### 4. 专家补充映射 → 只重算真正受影响的集合

`POST /shadow/snapshots/:id/revise` 从父快照派生子快照（仅 `mappings` 变化，目录/限制/费率继承）。
系统计算映射目标集合的精确差集 `changed_local_codes`，圈定本地区所有含这些本地编码的历史事件
`affected_event_refs`。增量作业只处理这批事件；读取子快照的差异汇总时，未重算的事件
**沿修订链向上沿用**父快照结论（响应里带 `evaluated_on_snapshot_id` 标明结论来自哪一代）。
无实质变化的修订会被拒绝。

### 5. 下钻读模型

```
GET /shadow/snapshots/:id/summary                      分类计数 + 双轨总额/差额
GET /shadow/snapshots/:id/drills/:category             某类别命中的费用行
GET /shadow/snapshots/:id/basis?event_ref=&line_ref=   该行双轨求值过程 + 规则/费率/映射原文
```

### 6. 抽样复核与发布门槛

- `createReviewPlan`：按类别**分层**、以快照+种子做**确定性洗牌抽样**（默认高风险三类
  `CODE_MISSING/RULE_CONFLICT/SCOPE_CHANGE` 100% 抽样，`AMOUNT_CHANGE` 10%，`MATCH` 2%）。
  同种子永远得到同一样本，可复现、可审计。
- 复核结论 `AGREE/DISAGREE` 一经记录不可改写。
- 门槛：样本全部复核完成、分歧率 ≤ 阈值（默认 5%）、各层达到期望样本量。
- **地区签署**绑定 `(region, snapshot_id, content_hash)`：门槛不过不能签；重复签署幂等。
- **发布活动**要求全部成员地区使用**同一国家目录版本**、且各自签署的内容哈希与当前快照一致；
  `issue` 颁发的证书 `scope = SHADOW_RELEASE_ELIGIBILITY_ONLY`——它只表示「获准环境内具备发布资格」，
  系统不存在向真实结算下发的后续动作。

## 安全边界（获准环境 / shadow lane）

实现在 `src/domain/enclave.js`，测试见 `tests/enclave.test.js`：

1. **摄入脱敏**：仅允许字段白名单（伪标识 `pseudo_*`、就医时点、机构等级、费用行等）；
   出现姓名/身份证/电话/住址/病历号等键模式即**整批拒绝**；超长字符串（疑似夹带病历文本）拒绝。
2. **存储边界**：账本路径必须解析在影子根目录内；命中 `production/`、`live/`、`patient-facing/`、
   `settle_db`、`claim-outbox` 等模式一律拒绝。
3. **HTTP 边界**：服务只监听 `127.0.0.1`；`/patient`、`/production`、`/live`、`/settle`
   在影子服务上**一律 403**；所有响应带 `x-shadow-lane: 1`、`Cache-Control: no-store`。
4. **出域脱敏**：`x-shadow-role: patient` 直接 403（影子结果永不进面向患者查询）；
   非授权角色的响应剥离内部费率字段；`analyst/reviewer/admin/system` 才可见样例费率。

## HTTP 接口（`/shadow` 前缀）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /shadow/history/ingest` | 脱敏摄入历史事件（数组或 `{events:[]}`），返回 ingested/duplicates |
| `GET  /shadow/history` | 已入库事件 |
| `POST /shadow/snapshots/freeze` | 冻结候选基线快照 |
| `GET  /shadow/snapshots[/:id]` | 快照列表/详情 |
| `POST /shadow/snapshots/:id/revise` | 专家补充/退役映射，返回受影响集合 |
| `POST /shadow/jobs` | 建作业 `{snapshot_id, mode, shard_count, request_id}` |
| `GET  /shadow/jobs[/:id]` | 作业与分片游标/租约状态 |
| `POST /shadow/jobs/:id/pause` · `/resume` | 协作式暂停/恢复 |
| `POST /shadow/jobs/:id/shards/:idx/lease` · `/run` | 租约/执行分片（`max_items`、`time_budget_ms`） |
| `GET  /shadow/snapshots/:id/summary` | 差异汇总 |
| `GET  /shadow/snapshots/:id/drills/:category` | 类别下钻 |
| `GET  /shadow/snapshots/:id/basis?event_ref=&line_ref=` | 规则依据下钻 |
| `POST /shadow/snapshots/:id/review-plans` | 建确定性分层抽样计划（`seed`、`strata`） |
| `POST /shadow/review-plans/:p/items/:i/review` | 记录 AGREE/DISAGREE |
| `GET  /shadow/review-plans/:p/gate` | 复核门槛状态 |
| `POST /shadow/regions/sign` | 地区签署（绑定内容哈希） |
| `POST /shadow/releases/check` · `/issue` | 多地区发布资格检查/颁发影子资格证书 |

调用示例：

```bash
curl -s -XPOST http://127.0.0.1:8088/shadow/snapshots/freeze \
  -H 'content-type: application/json' -H 'x-shadow-role: analyst' \
  -d @freeze-input.json
```

## 目录结构

```
bin/serve.js                 loopback HTTP 服务入口
bin/demo.js                  端到端演练脚本（虚构数据）
src/domain/
  events.js                  账本事件类型与信封校验
  errors.js                  稳定错误码（VALIDATION/NOT_FOUND/CONFLICT/GATE/ENCLAVE）
  hash.js                    规范化哈希、内容指纹、确定性随机
  enclave.js                 脱敏白名单/路径与 HTTP 边界/角色脱敏/shadow lane 标记
  catalog.js                 冻结快照、映射修订与受影响集合
  replay.js                  双轨重放引擎与差异分类
src/store/ledger.js          只追加 JSONL 账本（fsync、残段恢复）
src/store/reducer.js         事件回放 → 内存状态（重启恢复）
src/service/ShadowService.js 用例编排：摄入/作业/下钻/复核/签署/发布
src/server/http.js           /shadow HTTP 路由与边界
tests/                       47 个测试 + 夹具
```

## 运维说明

- 存储只有一个只追加账本 `<home>/ledger/events.jsonl`；备份即复制该文件。
  启动时全量重放恢复状态；异常退出留下的半行残段需经运维确认后用
  `Ledger.recoverTruncatedTail()` 截断（正常 fsync 提交不会产生残段）。
- 工作者循环建议：`lease → run（小批量/短时间预算）→ 按 stop_reason 决策`；
  `PAUSED/FENCED/LEASE_EXPIRED/TIME_BUDGET` 都是正常停止信号，重新租约或等待恢复即可。
- 候选目录、患者伪标识、内部样例费率仅存在于获准环境目录，**不要**把该目录放到
  真实结算库或患者查询库的挂载路径下（路径边界会拒绝，但隔离应在部署层面同样保证）。
