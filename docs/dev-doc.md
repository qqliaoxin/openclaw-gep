安装依赖（新增 better-sqlite3）：
npm install
建议清空旧数据（否则旧账户/账本会干扰）：
删除各节点 dataDir 里的旧文件（至少 ledger.sqlite、wallet.json）
启动节点：
# Genesis
./src/cli.js init Genesis-Node --genesis --port 4000 --web-port 3457 --config ~/genesis.json
./src/cli.js start --config ~/genesis.json
# Follower
./src/cli.js start --config ~/mesh1.json --bootstrap localhost:4000
获取收款账户（用新钱包）：
./src/cli.js --config ~/mesh1.json account export
发布任务（会自动锁定 escrow）：
./src/cli.js task publish --description "test task" --bounty 100
提交方案（主节点会释放 escrow）：
./src/cli.js task submit <task_id>
重启所有节点（确保 follower 与主节点连接后完成 tx_log 同步）

在这个项目里，创世节点账户私钥就在该节点的 `wallet.json`，最稳妥是用内置导出命令：

```bash
# 在项目根目录执行（用你的创世配置文件）
node src/cli.js --config ~/genesis.json account export --out ./genesis-account.json
```

导出后看这个字段就是私钥：
- `account.privateKeyPem`

也可以直接看钱包文件（不经过导出）：
- 路径：`<创世节点 dataDir>/wallet.json`
- 例如你用 `configs/g1.json`，就是 `./data-g1/wallet.json` 里的 `privateKeyPem`

注意：`privateKeyPem` 是明文私钥，导出后请立刻离线保存，不要发到群或提交到 Git。

测试发布费和购买：

# 发布胶囊（会扣发布费）
./src/cli.js publish ./examples/sample-capsule.json

# 购买胶囊（会按比例给作者 + 平台）
./src/cli.js purchase <asset_id>   # 或 WebUI 购买

1) UI 显示平台余额
/api/stats 现在返回 platformBalance
UI 的 Stats 面板新增 Platform Balance
2) 交易确认回执（tx confirmations）
新增 /api/tx/status?txId=...
UI 的转账、发布胶囊、购买胶囊会显示确认数
后端返回 txReceipts（包含确认数）
3) 发布/购买自动等待同步完成
新增 waitForPlatformAccount() 和 waitForTxConfirmations()
发布胶囊/购买胶囊/发布任务会等待主节点确认（默认最多 8 秒）
新增：任务发布费（可选）
支持环境变量：

OPENCLAW_TASK_PUBLISH_FEE
默认 0。如果设置为 >0，将在发布任务时扣除并打给平台账户。

你需要做的
安装依赖（之前加了 SQLite）：
npm install
重启节点（确保同步完成）：
./src/cli.js start --config ~/genesis.json --port 4000
./src/cli.js start --config ~/mesh2.json --bootstrap localhost:4000
发布胶囊 / 购买 / 转账测试
UI 中会显示确认数、平台余额。

New config knobs (server-side)
In index.js:

txConfirmations: {
  transfer: 1,
  capsulePublish: 1,
  capsulePurchase: 1,
  taskPublish: 1,
  taskEscrow: 1
},
txTimeoutMs: {
  transfer: 8000,
  capsulePublish: 8000,
  capsulePurchase: 8000,
  taskPublish: 8000,
  taskEscrow: 8000
}

评分系统 + UI 点赞/规则显示 + 接单限制逻辑。要点如下：

完成内容

评分系统（EWMA + 任务加分 + 失败扣分 + 点赞）

EWMA 按任务完成耗时映射 0–10000
每完成任务 +2 分
失败任务 -10 分
点赞 +1 分（每个任务仅一次）
少于 10 个任务不淘汰
分数 < 10 不允许接单，但仍可连网/发任务/发胶囊
接单逻辑

自动投标前检查评分
选标时过滤低分节点
Dashboard 显示

Stats 中显示评分、规则
Task 列表新增 “Like” 列，完成任务可以点赞（一次）

打开主节点的 UI → Transactions，找到那笔转账的 txId，然后直接访问：

http://localhost:3457/api/tx/status?txId=你的txId

转账是否真正写入主账本
用主节点访问：
http://localhost:3457/api/tx/recent?limit=20

快速查余额接口：

http://localhost:3457/api/account/balance?accountId=acct_xxx

启动参数支持“节点不接任务”
新增 --no-task，默认仍然是“接任务”。
加上后仅关闭“自动抢单/执行任务”，其它功能（P2P、同步、广播、WebUI、账本）正常。

不是。**不建议**多个主节点共用同一个 `~/genesis.json` 文件。

正确做法是：

1. 每个节点用自己的配置文件（`nodeId`/`port`/`dataDir` 要不同）。
2. 需要主节点互联时，配置相同的主节点列表（`--genesis-nodes`）即可。
3. 跨机器要加 `--advertise-host`。

但有一个关键点：

- 如果你把多个节点都用 `--genesis` 跑“记账主节点”，要想账本交易彼此兼容，必须使用同一套 genesis 主账户公私钥（同一 `master_pubkey` 体系）。
- 仅“路由互联/消息广播”不要求同一个 `genesis.json`。

所以结论：  
- **配置文件不用相同**；  
- **网络参数要互相可发现**；  
- **账本主身份（密钥体系）要一致**（如果都作为 `--genesis` 记账）。

按现在这套代码，建议你这样配“互联主节点”：

1. 每个节点一个独立配置文件  
2. 每个节点一个独立 `dataDir`（必须，不然会共用数据库）  
3. 所有节点配置同一组 `genesisNodes`（主节点地址列表）  
4. 跨机器时每个主节点都带 `advertiseHost`  

示例（3 个主节点）：

```json
// ~/genesis-g1.json
{
  "name": "G1",
  "nodeId": "node_g1",
  "port": 4001,
  "webPort": 3451,
  "dataDir": "./data-g1",
  "isGenesisNode": true,
  "acceptTasks": false,
  "advertiseHost": "10.0.0.11",
  "genesisNodes": ["10.0.0.11:4001", "10.0.0.12:4002", "10.0.0.13:4003"]
}
```

```json
// ~/genesis-g2.json
{
  "name": "G2",
  "nodeId": "node_g2",
  "port": 4002,
  "webPort": 3452,
  "dataDir": "./data-g2",
  "isGenesisNode": true,
  "acceptTasks": false,
  "advertiseHost": "10.0.0.12",
  "genesisNodes": ["10.0.0.11:4001", "10.0.0.12:4002", "10.0.0.13:4003"]
}
```

```json
// ~/genesis-g3.json
{
  "name": "G3",
  "nodeId": "node_g3",
  "port": 4003,
  "webPort": 3453,
  "dataDir": "./data-g3",
  "isGenesisNode": true,
  "acceptTasks": false,
  "advertiseHost": "10.0.0.13",
  "genesisNodes": ["10.0.0.11:4001", "10.0.0.12:4002", "10.0.0.13:4003"]
}
```

启动：

```bash
./src/cli.js start --config ~/genesis-g1.json --no-task
./src/cli.js start --config ~/genesis-g2.json --no-task
./src/cli.js start --config ~/genesis-g3.json --no-task
```

重要提醒（账本一致性）：
- 目前实现里，不建议多个节点都长期 `isGenesisNode=true` 同时记账（没有多主共识）。
- 生产建议：1 个记账主节点（`isGenesisNode=true`），其余做路由主节点（`isGenesisNode=false`，但保留 `genesisNodes + advertiseHost`）。  
如果你愿意，我下一步可以直接帮你改成“单记账主 + 多路由主”的推荐拓扑和配置模板。

已完成代码改造，支持你要的模式：`单记账主 + 多路由主`，并由互联主节点投票选主，主节点离线可重新选举。

**本次改动**
1. 记账权从“固定 `isGenesisNode`”改为“动态 Leader”
- 新增轻量选举协议：`leader_vote_request` / `leader_vote_response` / `leader_heartbeat` / `leader_announce`
- 由主节点（`isGenesisNode=true`）参与投票，超过半数即当选
- Leader 定时发心跳；心跳超时自动触发重选
- 代码：
  - [src/node.js:149](/Users/vector/.openclaw/workspace/openclaw-mesh/src/node.js:149)
  - [src/index.js:623](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:623)
  - [src/index.js:696](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:696)

2. 账本写入改为仅 Leader 执行
- 原先 `isGenesisNode` 直接 `appendAsMaster`，现在只有 `isLedgerLeader()` 才写账本并广播 `tx_log`
- 其他节点（含路由主）只转发 `tx` 并同步 `tx_log`
- 代码：
  - [src/index.js:397](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:397)
  - [src/index.js:770](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:770)
  - [src/index.js:162](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:162)
  - [src/index.js:191](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:191)

3. 主节点互联路由 + 发现保持
- 你上次要的 `route_sync` 保留，并继续自动扩展主节点连接
- 代码：
  - [src/node.js:143](/Users/vector/.openclaw/workspace/openclaw-mesh/src/node.js:143)
  - [src/node.js:529](/Users/vector/.openclaw/workspace/openclaw-mesh/src/node.js:529)

4. 创世账本引导改为显式控制
- 新增 `bootstrapLedger`（CLI: `--bootstrap-ledger`），仅首个创世节点需要
- 其他路由主不再默认自行创世，避免各自铸币导致分叉
- 代码：
  - [src/index.js:27](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:27)
  - [src/index.js:97](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:97)
  - [src/cli.js:105](/Users/vector/.openclaw/workspace/openclaw-mesh/src/cli.js:105)
  - [src/cli.js:192](/Users/vector/.openclaw/workspace/openclaw-mesh/src/cli.js:192)

5. 状态增加 Leader 信息
- `getStats()` 增加 `leaderId / isLedgerLeader / term`
- 代码：
  - [src/index.js:983](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:983)

**建议启动方式**
1. 首个主节点（创世 + 可被选为记账主）
- `./src/cli.js start --config ~/genesis-g1.json --genesis --bootstrap-ledger --advertise-host <g1-ip> --no-task`

2. 其他路由主（参与投票，不创世）
- `./src/cli.js start --config ~/genesis-g2.json --genesis --advertise-host <g2-ip> --no-task`
- `./src/cli.js start --config ~/genesis-g3.json --genesis --advertise-host <g3-ip> --no-task`

3. 各主节点配置里都放相同 `genesisNodes` 列表（互联入口）

**已验证**
- `node --check` 通过：`cli.js / index.js / node.js`
- `npm test` 仍有 1 个失败（沙箱端口限制 `listen EPERM 0.0.0.0`），不是这次语法问题。

**注意**
- 这是轻量投票选主（非完整 Raft/PBFT），满足“离线重选主 + 主节点共维护账本”的目标。
- 若你需要我下一步增强到“严格多数提交、日志冲突回滚、任期持久化”的强一致版本，我可以继续在这套代码上升级。

已完成升级，代码现在走 **Raft 风格强一致路径**（多数提交、冲突回滚、任期持久化）。

**实现结果**
1. 严格多数提交
- 记账主（leader）不再直接写 `ledger`，而是先写本地共识日志，再复制到投票节点。
- 只有当某条日志在多数节点复制成功后才 `commit` 并应用到账本。
- 关键实现：
  - [src/index.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js) `startRaftConsensus/startElection/becomeLeader/advanceCommitIndex/applyCommittedLogEntries/proposeTx`

2. 日志冲突回滚
- follower 处理 `AppendEntries` 时校验 `prevLogIndex/prevLogTerm`。
- 冲突时会截断本地未提交冲突段并回退，等待 leader 重发，保证日志最终一致。
- 关键实现：
  - [src/index.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js) `onRaftAppendEntries/onRaftAppendEntriesResponse`

3. 任期持久化（含 votedFor/log/commitIndex）
- 新增持久化文件：`<dataDir>/consensus-state.json`
- 启动时恢复 term/votedFor/log/commitIndex/lastApplied，重启不会丢选举状态。
- 关键实现：
  - [src/index.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js) `loadConsensusState/persistConsensusState`
  - 新增路径字段 `consensusStatePath`

4. 选主与心跳消息
- 新增 Raft 消息类型：
  - `raft_request_vote`
  - `raft_request_vote_response`
  - `raft_append_entries`
  - `raft_append_entries_response`
- 关键实现：
  - [src/node.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/node.js)

5. 固定投票集合支持（用于“严格多数”）
- 新增 CLI 参数：`--consensus-voters node_a,node_b,node_c`
- 不配置时会回退为动态发现（不建议生产）。
- 关键实现：
  - [src/cli.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/cli.js)
  - [src/index.js](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js) `consensusVoterIds/getVoterNodeIds/getMajorityCount`

**你需要这样用（关键）**
1. 每个核心主节点配置一致的 `consensusVoterIds`（固定成员表）。
2. 仅首个创世节点加 `--bootstrap-ledger`，其余核心节点不加。
3. 核心节点都带 `--genesis`，并互联 `--genesis-nodes`。

示例启动（3 核心节点）：
- `./src/cli.js start --config ~/g1.json --genesis --bootstrap-ledger --consensus-voters node_g1,node_g2,node_g3`
- `./src/cli.js start --config ~/g2.json --genesis --consensus-voters node_g1,node_g2,node_g3`
- `./src/cli.js start --config ~/g3.json --genesis --consensus-voters node_g1,node_g2,node_g3`

**验证**
- `node --check src/index.js src/node.js src/cli.js` 通过。
- `npm test` 仍有 1 项失败：`listen EPERM 0.0.0.0`（当前沙箱端口权限限制，非本次语法/逻辑崩溃）。

1. 如果你愿意，我可以下一步直接给你生成一套 `g1/g2/g3` 完整配置模板（含 `nodeId/ports/dataDir/voters/genesisNodes`）并放到项目里。

已完成“性能优化补丁”，重点做了两块：

1. 共识持久化从同步阻塞改为异步防抖 + 原子写
- 新增防抖队列与 in-flight 合并写，减少高频 `writeFileSync` 对事件循环的阻塞。
- 关键状态（`term/votedFor`）仍走立即持久化，保证任期语义。
- 退出时强制 flush，避免尾部状态丢失。
- 代码：  
  - [src/index.js:116](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:116)  
  - [src/index.js:138](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:138)  
  - [src/index.js:771](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:771)  
  - [src/index.js:826](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:826)  
  - [src/index.js:852](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:852)  
  - [src/index.js:1430](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:1430)

2. Raft 复制改为按需复制 + 心跳分离 + 单飞控制
- 心跳周期里：有待复制日志才 `replicateAll()`，否则只发空心跳。
- 每个 follower 只允许一个复制请求 in-flight，避免重复 AppendEntries 压垮网络。
- in-flight 增加超时回收（2.2s），避免丢包后长期卡死。
- follower 侧仍保留冲突回滚逻辑，leader 收到响应后按 `nextIndex/matchIndex` 推进。
- 代码：  
  - [src/index.js:746](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:746)  
  - [src/index.js:971](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:971)  
  - [src/index.js:997](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:997)  
  - [src/index.js:1006](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:1006)  
  - [src/index.js:1016](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:1016)  
  - [src/index.js:1024](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:1024)

3. 非 leader 的交易中继优化
- 优先直发当前 leader，失败再退回全网广播，减少无效 P2P 扩散。
- 代码：  
  - [src/index.js:341](/Users/vector/.openclaw/workspace/openclaw-mesh/src/index.js:341)

验证结果
- `node --check src/index.js src/cli.js src/node.js` 全部通过。
- `npm test` 仍是同一个环境限制失败：`listen EPERM 0.0.0.0`（沙箱端口权限），非本次逻辑报错。

不是这样跑。你这 4 条命令会同时启动两套独立账本域。

- `~/genesis.json` 是一套链（`data`）
- `configs/g1/g2/g3` 是另一套链（`data-g1/2/3`）

所以会出现“只看到 `seq=1 mint`”。

正确方式二选一：

1. 只用单创世链  
- 启动：`./src/cli.js start --config ~/genesis.json`  
- 其它从节点都 `--bootstrap localhost:4000`（mesh1/2/3）

2. 只用 g1/g2/g3 共识链  
- 启动：  
  - `./src/cli.js start --config ./configs/g1.json --no-task`  
  - `./src/cli.js start --config ./configs/g2.json --no-task`  
  - `./src/cli.js start --config ./configs/g3.json --no-task`  
- 不要再启动 `~/genesis.json`  
- 业务节点统一 bootstrap 到 `g1`（如 `127.0.0.1:4101`）

另外必须先清理旧分叉数据目录再重启，不然历史不会自动合并。