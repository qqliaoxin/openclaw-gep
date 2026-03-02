#!/usr/bin/env node
/**
 * OpenClaw Task CLI
 * 命令行接口
 */

const OpenClawMesh = require('./index');
const MeshNode = require('./node');
const MemoryStore = require('./memory-store');
const LedgerStore = require('./ledger-store');
const { loadOrCreateWallet, signPayload } = require('./wallet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 默认配置文件路径
let CONFIG_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw-task.json');

// 解析命令行参数
function getArg(args, key, defaultVal = null) {
    const idx = args.indexOf(key);
    if (idx >= 0 && idx + 1 < args.length) {
        return args[idx + 1];
    }
    // 支持 --key=value 格式
    for (const arg of args) {
        if (arg.startsWith(key + '=')) {
            return arg.substring(key.length + 1);
        }
    }
    return defaultVal;
}

function parseAddressList(value) {
    if (!value || typeof value !== 'string') return [];
    return value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

// 加载配置
function loadConfig(configPath = null) {
    const file = configPath || CONFIG_FILE;
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return {};
}

// 保存配置
function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function ensureNodeConfig(config) {
    const crypto = require('crypto');
    if (!config.nodeId) {
        config.nodeId = 'node_' + crypto.randomBytes(8).toString('hex');
    }
    if (!config.dataDir) {
        config.dataDir = './data';
    }
    saveConfig(config);
    return config;
}

// 显示帮助
function showHelp() {
    console.log(`
OpenClaw Task - 去中心化技能共享网络

用法:
  openclaw-task <command> [options]

命令:
  init [name]          初始化节点
  start                启动节点
  stop                 停止节点
  status               查看节点状态
  publish <file>       发布记忆胶囊
  memories [filter]    列出记忆
  search <query>       搜索记忆
  task publish         发布任务
  task list            列出任务
  task submit <id>     提交解决方案
  account export       导出账户JSON
  account import <file>导入账户JSON
  account transfer     账本转账
  sync                 同步网络记忆
  webui                打开WebUI
  config               查看配置

选项:
  --config <path>      指定配置文件路径
  --port <number>      设置P2P端口
  --web-port <number>  设置WebUI端口
  --bootstrap <addr>   添加引导节点
  --tags <tags>        设置标签（逗号分隔）
  --master <url>       设置主节点URL
  --genesis            标记为主节点
  --no-task            不接任务（仅关闭抢单/执行，其他功能正常）
  --genesis-nodes <list> 指定主节点列表（逗号分隔 host:port）
  --advertise-host <host> 对外宣告本节点主机地址（跨机房推荐）
  --bootstrap-ledger    将本节点作为账本创世节点（仅首个记账主需要）
  --consensus-voters <list> 指定投票节点ID列表（逗号分隔 node_xxx）

示例:
  openclaw-task init MyNode
  openclaw-task start --port 4001
  openclaw-task start --config ./my-mesh.json
  openclaw-task publish ./skill.json --tags trading,api
  openclaw-task search "JSON parse error"
  openclaw-task task publish --description "优化性能" --bounty 100
  openclaw-task account export --out account.json
  openclaw-task account import ./account.json
  openclaw-task account transfer --to-account acct_xxx --amount 100
  openclaw-task account transfer --to-account acct_xxx --amount 100 --bootstrap localhost:4000
`);
}

// 初始化节点
async function init(args) {
    const name = args[0] || 'MyNode';
    const nodeId = 'node_' + require('crypto').randomBytes(8).toString('hex');
    
    // 解析命令行参数
    const port = parseInt(getArg(args, '--port')) || 0;
    const webPort = parseInt(getArg(args, '--web-port')) || 3457;
    const bootstrap = getArg(args, '--bootstrap');
    const tags = getArg(args, '--tags', '');
    const masterUrl = getArg(args, '--master', '');
    const isGenesisNode = args.includes('--genesis');
    
    const bootstrapNodes = bootstrap ? [bootstrap] : [];
    const nodeTags = tags ? tags.split(',').map(t => t.trim()) : [];
    
    const config = {
        name,
        nodeId,
        port,
        webPort,
        bootstrapNodes,
        tags: nodeTags,
        dataDir: './data',
        masterUrl,
        isGenesisNode,
        createdAt: new Date().toISOString()
    };

    if (isGenesisNode) {
        const store = new MemoryStore(config.dataDir, {
            nodeId,
            isGenesisNode: true,
            useLance: false
        });
        await store.init();
        try {
            const operatorAccount = store.ensureAccount(nodeId, { algorithm: 'gep-lite-v1' });
            config.genesisOperatorAccountId = operatorAccount.accountId;
            console.log(`🔐 Genesis operator account: ${operatorAccount.accountId}`);
        } finally {
            await store.close();
        }
    }

    saveConfig(config);
    
    console.log(`✅ Node initialized: ${name}`);
    console.log(`   Node ID: ${nodeId}`);
    console.log(`   P2P Port: ${port || '(random)'}`);
    console.log(`   WebUI Port: ${webPort}`);
    console.log(`   Config: ${CONFIG_FILE}`);
}

// 启动节点
async function start(args, configPath = null) {
    const config = loadConfig(configPath);
    const cliGenesisNodes = parseAddressList(getArg(args, '--genesis-nodes', ''));
    const cliConsensusVoters = parseAddressList(getArg(args, '--consensus-voters', ''));
    const configGenesisNodes = Array.isArray(config.genesisNodes) ? config.genesisNodes : [];
    const mergedGenesisNodes = Array.from(new Set([...configGenesisNodes, ...cliGenesisNodes]));
    const configConsensusVoters = Array.isArray(config.consensusVoterIds) ? config.consensusVoterIds : [];
    const mergedConsensusVoters = Array.from(new Set([...configConsensusVoters, ...cliConsensusVoters]));
    
    const options = {
        nodeId: config.nodeId,
        port: getArg(args, '--port') || config.port || 0,
        webPort: getArg(args, '--web-port') || config.webPort || 3457,
        bootstrapNodes: config.bootstrapNodes || [],
        genesisNodes: mergedGenesisNodes,
        consensusVoterIds: mergedConsensusVoters,
        dataDir: config.dataDir || './data',
        masterUrl: getArg(args, '--master') || config.masterUrl || null,
        advertiseHost: getArg(args, '--advertise-host') || config.advertiseHost || null,
        isGenesisNode: args.includes('--genesis') || config.isGenesisNode || false,
        bootstrapLedger: args.includes('--bootstrap-ledger') ? true : (config.bootstrapLedger === true ? true : undefined),
        genesisOperatorAccountId: config.genesisOperatorAccountId || null,
        acceptTasks: !(args.includes('--no-task') || config.acceptTasks === false)
    };
    
    // 如果有bootstrap参数
    const bootstrap = getArg(args, '--bootstrap');
    if (bootstrap) {
        options.bootstrapNodes.push(bootstrap);
    }
    
    const mesh = new OpenClawMesh(options);
    await mesh.init();
    
    // 保存实例供后续使用
    global.meshInstance = mesh;
    
    // 保持运行
    console.log('\n⏳ Node is running... Press Ctrl+C to stop\n');
    
    process.on('SIGINT', async () => {
        await mesh.stop();
        process.exit(0);
    });
}

// 查看状态
async function status(configPath = null) {
    const config = loadConfig(configPath);
    
    if (!global.meshInstance) {
        console.log('⚠️  Node not running');
        console.log(`   Node ID: ${config.nodeId || 'Not initialized'}`);
        return;
    }
    
    const stats = global.meshInstance.getStats();
    
    console.log('\n📊 Node Status');
    console.log('=' .repeat(40));
    console.log(`Node ID: ${stats.nodeId}`);
    console.log(`Uptime: ${Math.floor(stats.uptime)}s`);
    console.log(`Peers: ${stats.peers.length}`);
    console.log(`Memories: ${stats.memoryCount}`);
    console.log(`Tasks: ${stats.taskCount}`);
    console.log(`WebUI: http://localhost:${global.meshInstance.options.webPort}`);
}

// 发布记忆
async function publish(args) {
    const file = args[0];
    if (!file) {
        console.error('❌ Please specify a file');
        return;
    }
    
    if (!fs.existsSync(file)) {
        console.error(`❌ File not found: ${file}`);
        return;
    }
    
    const content = fs.readFileSync(file, 'utf8');
    let capsule;
    
    try {
        capsule = JSON.parse(content);
    } catch (e) {
        // 如果不是JSON，作为原始内容处理
        capsule = {
            content: {
                gene: {
                    trigger: 'manual',
                    solution: content
                },
                capsule: {
                    type: 'skill',
                    code: content,
                    confidence: 0.8
                }
            }
        };
    }
    
    // 添加标签
    const tags = getArg(args, '--tags');
    if (tags) {
        capsule.content.capsule.blast_radius = tags.split(',');
    }
    
    if (!global.meshInstance) {
        console.error('❌ Node not running. Start with: openclaw-task start');
        return;
    }
    
    const result = await global.meshInstance.publishCapsule(capsule);
    const assetId = result.assetId || result;
    console.log(`✅ Published: ${assetId}`);
}

// 列出记忆
async function memories(args) {
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    const filter = {};
    if (args[0]) {
        filter.tags = [args[0]];
    }
    
    const capsules = global.meshInstance.memoryStore.queryCapsules(filter);
    
    console.log(`\n📦 Memories (${capsules.length} total)`);
    console.log('=' .repeat(60));
    
    capsules.slice(0, 20).forEach((c, i) => {
        console.log(`\n${i + 1}. ${c.asset_id.slice(0, 20)}...`);
        console.log(`   Type: ${c.type} | Confidence: ${(c.confidence * 100).toFixed(0)}%`);
        console.log(`   Creator: ${c.attribution.creator}`);
        console.log(`   Tags: ${c.tags.join(', ')}`);
    });
}

// 搜索记忆
async function search(args) {
    const query = args[0];
    if (!query) {
        console.error('❌ Please specify a search query');
        return;
    }
    
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    const results = global.meshInstance.memoryStore.searchMemories(query);
    
    console.log(`\n🔍 Search: "${query}" (${results.length} results)`);
    console.log('=' .repeat(60));
    
    results.forEach((r, i) => {
        console.log(`\n${i + 1}. ${r.asset_id.slice(0, 20)}...`);
        console.log(`   Confidence: ${(r.confidence * 100).toFixed(0)}%`);
    });
}

// 任务命令
async function taskCommand(subcommand, args) {
    switch (subcommand) {
        case 'publish':
            await publishTask(args);
            break;
        case 'list':
            await listTasks();
            break;
        case 'submit':
            await submitSolution(args);
            break;
        default:
            console.log('Usage: openclaw-task task <publish|list|submit>');
    }
}

async function publishTask(args) {
    const description = getArg(args, '--description');
    const bounty = parseInt(getArg(args, '--bounty')) || 100;
    
    if (!description) {
        console.error('❌ Please specify --description');
        return;
    }
    
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    const task = {
        description,
        type: 'code',
        bounty: {
            amount: bounty,
            token: 'CLAW'
        },
        deadline: new Date(Date.now() + 86400000).toISOString()
    };
    
    const result = await global.meshInstance.publishTask(task);
    const taskId = result.taskId || result;
    console.log(`✅ Task published: ${taskId}`);
}

async function listTasks() {
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    const tasks = global.meshInstance.taskBazaar.getTasks();
    
    console.log(`\n🎯 Tasks (${tasks.length} total)`);
    console.log('=' .repeat(60));
    
    tasks.forEach((t, i) => {
        console.log(`\n${i + 1}. ${t.taskId}`);
        console.log(`   ${t.description}`);
        console.log(`   Status: ${t.status} | Bounty: ${t.bounty.amount} ${t.bounty.token}`);
    });
}

async function submitSolution(args) {
    const taskId = args[0];
    if (!taskId) {
        console.error('❌ Please specify task ID');
        return;
    }
    
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    // 这里简化处理，实际应该读取文件或交互输入
    const solution = {
        description: 'Solution submitted via CLI',
        code: '// TODO: Implement solution'
    };
    
    const result = await global.meshInstance.submitSolution(taskId, solution);
    
    if (result.success) {
        console.log(`✅ Solution accepted!`);
        if (result.winner) {
            console.log(`🏆 You won the bounty: ${result.reward}`);
        }
    } else {
        console.log(`❌ Solution rejected: ${result.reason}`);
    }
}

// 同步记忆
async function sync(args) {
    if (!global.meshInstance) {
        console.error('❌ Node not running');
        return;
    }
    
    console.log('🔄 Syncing memories from network...');
    const count = await global.meshInstance.syncMemories();
    console.log(`✅ Synced ${count} memories`);
}

// 查看配置
async function config() {
    const cfg = loadConfig();
    console.log('\n⚙️  Configuration');
    console.log('=' .repeat(40));
    console.log(JSON.stringify(cfg, null, 2));
}

async function accountCommand(subcommand, args, configPath = null) {
    const config = loadConfig(configPath) || {};
    if (!config.nodeId) {
        config.nodeId = 'node_' + require('crypto').randomBytes(8).toString('hex');
    }
    const dataDir = config.dataDir || './data';
    const isBootstrapLedger = config.bootstrapLedger === true || (
        (config.isGenesisNode || false) &&
        ((config.bootstrapNodes || []).length === 0) &&
        ((config.genesisNodes || []).length === 0)
    );
    let ledger = null;
    try {
        if (subcommand === 'export') {
            const wallet = loadOrCreateWallet(dataDir);
            ledger = new LedgerStore(dataDir);
            ledger.init({ isGenesis: isBootstrapLedger, genesisAccountId: wallet.accountId, genesisSupply: 1000000, genesisPublicKeyPem: wallet.publicKeyPem, genesisPrivateKeyPem: wallet.privateKeyPem });
            const payload = {
                version: 2,
                exportedAt: new Date().toISOString(),
                account: {
                    accountId: wallet.accountId,
                    publicKeyPem: wallet.publicKeyPem,
                    privateKeyPem: wallet.privateKeyPem,
                    balance: ledger.getBalance(wallet.accountId),
                    nonce: ledger.getNonce(wallet.accountId)
                }
            };
            const outPath = getArg(args, '--out');
            if (outPath) {
                fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
                console.log(`✅ Account exported: ${path.resolve(outPath)}`);
            } else {
                console.log(JSON.stringify(payload, null, 2));
            }
            return;
        }
        if (subcommand === 'import') {
            const filePath = args[0] || getArg(args, '--in') || getArg(args, '--file');
            if (!filePath) {
                console.error('❌ Missing import file. Usage: openclaw-task account import <file>');
                return;
            }
            const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
            const payload = JSON.parse(raw);
            const { importWallet } = require('./wallet');
            const wallet = importWallet(dataDir, payload);
            console.log(`✅ Account imported: ${wallet.accountId}`);
            return;
        }
        if (subcommand === 'transfer') {
            const wallet = loadOrCreateWallet(dataDir);
            ledger = new LedgerStore(dataDir);
            ledger.init({ isGenesis: isBootstrapLedger, genesisAccountId: wallet.accountId, genesisSupply: 1000000, genesisPublicKeyPem: wallet.publicKeyPem, genesisPrivateKeyPem: wallet.privateKeyPem });
            const toAccountIdRaw = getArg(args, '--to-account') || getArg(args, '--to');
            const amount = Number(getArg(args, '--amount'));
            const bootstrap = getArg(args, '--bootstrap');
            const bootstrapNodes = [
                ...(config.bootstrapNodes || []),
                ...(bootstrap ? [bootstrap] : [])
            ];
            if (!toAccountIdRaw || !Number.isFinite(amount) || amount <= 0) {
                const missing = [];
                if (!toAccountIdRaw) missing.push('--to-account');
                if (!Number.isFinite(amount) || amount <= 0) missing.push('--amount');
                console.error(`❌ Missing required option(s): ${missing.join(', ')}`);
                console.error('Usage: openclaw-task account transfer --to-account <accountId> --amount <number> [--bootstrap <host:port>]');
                return;
            }
            if (bootstrapNodes.length === 0) {
                console.error('❌ Missing bootstrap node. Use --bootstrap <host:port> or set bootstrapNodes in config.');
                return;
            }
            const nonce = ledger.getNonce(wallet.accountId) + 1;
            const payload = {
                type: 'transfer',
                from: wallet.accountId,
                to: toAccountIdRaw,
                amount: Number(amount),
                nonce,
                timestamp: Date.now()
            };
            const signature = signPayload(wallet.privateKeyPem, payload);
            const tx = {
                ...payload,
                pubkeyPem: wallet.publicKeyPem,
                signature,
                txId: crypto.createHash('sha256').update(JSON.stringify({ ...payload, signature })).digest('hex')
            };
            const tempNodeId = `${config.nodeId}_cli_${crypto.randomBytes(3).toString('hex')}`;
            const node = new MeshNode({
                nodeId: tempNodeId,
                port: 0,
                bootstrapNodes
            });
            try {
                await node.init();
                // Wait briefly for at least one live peer to avoid sending tx before handshake.
                const waitStart = Date.now();
                while (Date.now() - waitStart < 5000) {
                    if ((node.getPeers() || []).length > 0) break;
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                if ((node.getPeers() || []).length === 0) {
                    console.error('❌ No reachable peers after 5s. Check --bootstrap and node connectivity.');
                    return;
                }

                const envelope = {
                    type: 'tx',
                    payload: tx,
                    timestamp: Date.now()
                };
                let relayedPeers = 0;
                for (let i = 0; i < 5; i++) {
                    const peers = node.getPeers() || [];
                    for (const peer of peers) {
                        if (node.sendToPeer(peer.nodeId, envelope)) {
                            relayedPeers += 1;
                        }
                    }
                    node.broadcastAll(envelope);
                    await new Promise(resolve => setTimeout(resolve, 450));
                }
                await new Promise(resolve => setTimeout(resolve, 800));
                console.log(JSON.stringify({ submitted: true, txId: tx.txId, relayedPeers }, null, 2));
            } finally {
                await node.stop();
            }
            return;
        }
        console.log('Usage: openclaw-task account <export|import|transfer>');
    } finally {
        if (ledger) ledger.close();
    }
}

// 主函数
async function main() {
    let args = process.argv.slice(2);
    
    // 解析 --config 选项（允许出现在任意位置）
    const configArg = getArg(args, '--config');
    if (configArg) {
        CONFIG_FILE = path.resolve(configArg);
        console.log(`📄 Using config: ${CONFIG_FILE}`);
    }
    // 剔除全局参数，避免影响命令解析
    if (configArg) {
        const idx = args.indexOf('--config');
        if (idx >= 0) {
            args = args.slice(0, idx).concat(args.slice(idx + 2));
        } else {
            // 支持 --config=path
            args = args.filter(arg => !arg.startsWith('--config='));
        }
    }
    
    const command = args[0];
    const subArgs = args.slice(1);
    
    switch (command) {
        case 'init':
            await init(subArgs);
            break;
        case 'start':
            await start(subArgs, configArg);
            break;
        case 'stop':
            console.log('Use Ctrl+C to stop the node');
            break;
        case 'status':
            await status(configArg);
            break;
        case 'publish':
            await publish(subArgs);
            break;
        case 'memories':
            await memories(subArgs);
            break;
        case 'search':
            await search(subArgs);
            break;
        case 'task':
            await taskCommand(subArgs[0], subArgs.slice(1));
            break;
        case 'account':
            await accountCommand(subArgs[0], subArgs.slice(1), configArg);
            break;
        case 'sync':
            await sync(subArgs);
            break;
        case 'config':
            await config();
            break;
        case 'webui':
            console.log('Open http://localhost:3457 in your browser');
            break;
        case 'help':
        case '-h':
        case '--help':
        default:
            showHelp();
    }
}

main().catch(console.error);
