/**
 * OpenClaw Mesh - 去中心化技能共享网络
 * Main Entry Point
 */

const MeshNode = require('./node');
const MemoryStore = require('./memory-store');
const TaskBazaar = require('./task-bazaar');
const WebUIServer = require('../web/server');
const TaskWorker = require('./task-worker');
const LedgerStore = require('./ledger-store');
const { loadOrCreateWallet, signPayload, accountIdFromPublicKey, importWallet } = require('./wallet');
const crypto = require('crypto');
const RatingStore = require('./rating-store');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class OpenClawMesh {
    constructor(options = {}) {
        this.options = {
            nodeId: options.nodeId || this.generateNodeId(),
            port: options.port || 0,
            bootstrapNodes: options.bootstrapNodes || [],
            dataDir: options.dataDir || './data',
            webPort: options.webPort || 3457,
            isGenesisNode: options.isGenesisNode ?? process.env.OPENCLAW_IS_GENESIS === '1',
            bootstrapLedger: options.bootstrapLedger ?? (
                process.env.OPENCLAW_BOOTSTRAP_LEDGER === '1' ||
                ((options.bootstrapNodes || []).length === 0 && (options.isGenesisNode ?? process.env.OPENCLAW_IS_GENESIS === '1'))
            ),
            acceptTasks: options.acceptTasks ?? process.env.OPENCLAW_ACCEPT_TASKS !== '0',
            masterUrl: options.masterUrl || process.env.OPENCLAW_MASTER_URL || null,
            genesisNodes: options.genesisNodes || (process.env.OPENCLAW_GENESIS_NODES ? process.env.OPENCLAW_GENESIS_NODES.split(',').map(s => s.trim()).filter(Boolean) : []),
            consensusVoterIds: options.consensusVoterIds || (process.env.OPENCLAW_CONSENSUS_VOTERS ? process.env.OPENCLAW_CONSENSUS_VOTERS.split(',').map(s => s.trim()).filter(Boolean) : []),
            genesisOperatorAccountId: options.genesisOperatorAccountId || process.env.OPENCLAW_GENESIS_OPERATOR || null,
            capsulePriceDefault: Number(options.capsulePriceDefault ?? process.env.OPENCLAW_CAPSULE_PRICE ?? 10),
            capsuleCreatorShare: Number(options.capsuleCreatorShare ?? process.env.OPENCLAW_CAPSULE_CREATOR_SHARE ?? 0.9),
            capsulePublishFee: Number(options.capsulePublishFee ?? process.env.OPENCLAW_CAPSULE_PUBLISH_FEE ?? 1),
            taskPublishFee: Number(options.taskPublishFee ?? process.env.OPENCLAW_TASK_PUBLISH_FEE ?? 0),
            txConfirmations: options.txConfirmations || {
                transfer: 1,
                capsulePublish: 1,
                capsulePurchase: 1,
                taskPublish: 1,
                taskEscrow: 1
            },
            txTimeoutMs: options.txTimeoutMs || {
                transfer: 8000,
                capsulePublish: 8000,
                capsulePurchase: 8000,
                taskPublish: 8000,
                taskEscrow: 8000
            },
            ...options
        };
        
        this.node = null;
        this.memoryStore = null;
        this.taskBazaar = null;
        this.webUI = null;
        this.ledger = null;
        this.wallet = null;
        this.ratingStore = null;
        this.initialized = false;
        this.pendingTxs = new Map();
        this.pendingTxInterval = null;
        this.consensus = {
            role: 'follower', // follower | candidate | leader
            term: 0,
            leaderId: null,
            votedFor: null,
            votes: new Set(),
            log: [], // [{ index, term, txId, tx }]
            commitIndex: 0,
            lastApplied: 0,
            nextIndex: new Map(), // peerId -> next log index to send
            matchIndex: new Map(), // peerId -> highest replicated index
            replicationInFlight: new Set(), // peerIds currently waiting for append_entries_response
            replicationInFlightAt: new Map(), // peerId -> timestamp
            electionDeadlineAt: 0,
            electionInterval: null,
            heartbeatInterval: null
        };
        this.consensusStatePath = path.join(this.options.dataDir, 'consensus-state.json');
        this.consensusPersistTimer = null;
        this.consensusPersistPending = false;
        this.consensusPersistInFlight = null;
    }
    
    generateNodeId() {
        const crypto = require('crypto');
        return 'node_' + crypto.randomBytes(8).toString('hex');
    }

    loadConsensusState() {
        if (!this.isCoreNode()) return;
        try {
            if (!fsSync.existsSync(this.consensusStatePath)) return;
            const raw = JSON.parse(fsSync.readFileSync(this.consensusStatePath, 'utf8'));
            this.consensus.term = Number(raw.term || 0);
            this.consensus.votedFor = raw.votedFor || null;
            this.consensus.log = Array.isArray(raw.log) ? raw.log.map((e, i) => ({
                index: Number(e.index || i + 1),
                term: Number(e.term || 0),
                txId: e.txId || e.tx?.txId || null,
                tx: e.tx || null
            })) : [];
            this.consensus.commitIndex = Math.min(Number(raw.commitIndex || 0), this.consensus.log.length);
            this.consensus.lastApplied = Math.min(Number(raw.lastApplied || 0), this.consensus.commitIndex);
        } catch (e) {
            console.error('⚠️  Failed to load consensus state:', e.message);
        }
    }

    persistConsensusState(immediate = false) {
        if (!this.isCoreNode()) return;
        this.consensusPersistPending = true;
        if (immediate) {
            if (this.consensusPersistTimer) {
                clearTimeout(this.consensusPersistTimer);
                this.consensusPersistTimer = null;
            }
            this.flushConsensusState().catch((e) => {
                console.error('⚠️  Failed to persist consensus state:', e.message);
            });
            return;
        }
        if (this.consensusPersistTimer) return;
        this.consensusPersistTimer = setTimeout(() => {
            this.consensusPersistTimer = null;
            this.flushConsensusState().catch((e) => {
                console.error('⚠️  Failed to persist consensus state:', e.message);
            });
        }, 120);
    }

    async flushConsensusState() {
        if (!this.isCoreNode()) return;
        if (!this.consensusPersistPending && !this.consensusPersistInFlight) return;
        if (this.consensusPersistInFlight) {
            await this.consensusPersistInFlight;
            if (!this.consensusPersistPending) return;
        }
        this.consensusPersistPending = false;
        const payload = {
            version: 1,
            term: this.consensus.term,
            votedFor: this.consensus.votedFor,
            commitIndex: this.consensus.commitIndex,
            lastApplied: this.consensus.lastApplied,
            log: this.consensus.log.map(e => ({
                index: e.index,
                term: e.term,
                txId: e.txId,
                tx: e.tx
            }))
        };
        const tmpPath = `${this.consensusStatePath}.tmp`;
        this.consensusPersistInFlight = (async () => {
            await fs.mkdir(path.dirname(this.consensusStatePath), { recursive: true });
            await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
            await fs.rename(tmpPath, this.consensusStatePath);
        })();
        try {
            await this.consensusPersistInFlight;
        } finally {
            this.consensusPersistInFlight = null;
        }
        if (this.consensusPersistPending) {
            await this.flushConsensusState();
        }
    }

    bootstrapConsensusLogFromLedgerIfNeeded() {
        if (!this.isCoreNode()) return;
        if ((this.consensus.log || []).length > 0) return;
        const lastSeq = this.ledger.getLastSeq();
        if (!lastSeq) return;
        const entries = this.ledger.getTxLogSince(0, Math.max(100000, lastSeq + 10)) || [];
        if (entries.length === 0) return;
        this.consensus.log = entries.map((entry, idx) => ({
            index: idx + 1,
            term: 0,
            txId: entry.txId,
            tx: {
                type: entry.type,
                from: entry.from,
                to: entry.to,
                amount: entry.amount,
                nonce: entry.nonce,
                timestamp: entry.timestamp,
                pubkeyPem: entry.pubkeyPem,
                signature: entry.signature,
                txId: entry.txId
            }
        }));
        this.consensus.commitIndex = this.consensus.log.length;
        this.consensus.lastApplied = this.consensus.log.length;
        this.persistConsensusState();
    }

    getLastLogMeta() {
        const last = this.consensus.log[this.consensus.log.length - 1];
        if (!last) {
            return { lastLogIndex: 0, lastLogTerm: 0 };
        }
        return { lastLogIndex: last.index, lastLogTerm: last.term };
    }

    getVoterNodeIds() {
        if (!this.isCoreNode()) return [this.options.nodeId];
        if (Array.isArray(this.options.consensusVoterIds) && this.options.consensusVoterIds.length > 0) {
            return Array.from(new Set(this.options.consensusVoterIds));
        }
        const dynamic = this.node?.getGenesisPeerIds ? this.node.getGenesisPeerIds() : [];
        return Array.from(new Set([this.options.nodeId, ...dynamic]));
    }

    getMajorityCount() {
        const voters = this.getVoterNodeIds();
        return Math.floor(voters.length / 2) + 1;
    }

    resetElectionDeadline() {
        const timeoutMs = 3000 + Math.floor(Math.random() * 2000);
        this.consensus.electionDeadlineAt = Date.now() + timeoutMs;
    }
    
    async init() {
        console.log(`🚀 Initializing OpenClaw Mesh...`);
        console.log(`   Node ID: ${this.options.nodeId}`);
        
        // 初始化存储
        this.memoryStore = new MemoryStore(this.options.dataDir, {
            nodeId: this.options.nodeId,
            isGenesisNode: this.options.isGenesisNode,
            masterUrl: this.options.masterUrl,
            genesisOperatorAccountId: this.options.genesisOperatorAccountId
        });
        await this.memoryStore.init();
        this.wallet = loadOrCreateWallet(this.options.dataDir);
        this.ledger = new LedgerStore(this.options.dataDir);
        this.ledger.init({
            isGenesis: this.options.bootstrapLedger,
            genesisAccountId: this.wallet.accountId,
            genesisSupply: this.memoryStore.genesisSupply,
            genesisPublicKeyPem: this.wallet.publicKeyPem,
            genesisPrivateKeyPem: this.wallet.privateKeyPem
        });
        this.ratingStore = new RatingStore(this.options.dataDir, {
            alpha: 0.2,
            targetMs: 30 * 60 * 1000,
            minTasks: 10,
            threshold: 10
        });
        this.ratingStore.init();
        
        // 初始化P2P节点
        this.node = new MeshNode({
            nodeId: this.options.nodeId,
            port: this.options.port,
            bootstrapNodes: Array.from(new Set([...(this.options.bootstrapNodes || []), ...(this.options.genesisNodes || [])])),
            isGenesisNode: this.options.isGenesisNode,
            advertiseHost: this.options.advertiseHost || process.env.OPENCLAW_ADVERTISE_HOST || null
        });
        await this.node.init();
        this.loadConsensusState();
        this.bootstrapConsensusLogFromLedgerIfNeeded();
        this.applyCommittedLogEntries(false);

        // 账本广播由主节点处理 tx -> tx_log
        this.startLedgerSync();
        this.startPendingTxRelay();
        
        // 初始化任务市场
        this.taskBazaar = new TaskBazaar({
            nodeId: this.options.nodeId,
            memoryStore: this.memoryStore,
            ledger: this.ledger,
            walletAccountId: this.wallet.accountId,
            ratingStore: this.ratingStore,
            dataDir: this.options.dataDir
        });
        
        // 初始化任务处理器 (自动争单)
        this.taskWorker = new TaskWorker(this);
        if (this.options.acceptTasks) {
            this.taskWorker.startAutoBidding();
        } else {
            console.log('🛑 Task Worker disabled (--no-task). Node will not bid/execute tasks.');
        }
        
        // 初始化WebUI
        this.webUI = new WebUIServer({
            port: this.options.webPort,
            mesh: this
        });
        await this.webUI.start();
        
        // 设置事件监听
        this.setupEventHandlers();
        this.startRaftConsensus();
        
        this.initialized = true;
        console.log(`✅ OpenClaw Mesh initialized successfully!`);
        console.log(`   WebUI: http://localhost:${this.options.webPort}`);
        
        return this;
    }

    startLedgerSync() {
        if (this.ledgerSyncInterval) {
            clearInterval(this.ledgerSyncInterval);
        }
        let tickCount = 0;
        const request = () => {
            if (!this.node || !this.ledger) return;
            if (this.isLedgerLeader()) return;
            const peers = this.node.getPeers();
            if (!peers || peers.length === 0) return;
            tickCount += 1;
            const forceFull = tickCount % 12 === 0; // roughly every 60s
            const sinceSeq = forceFull ? 0 : this.ledger.getLastSeq();
            console.log(`🔄 Ledger sync request: sinceSeq=${sinceSeq} peers=${peers.length}`);
            for (const peer of peers) {
                const ok = this.node.sendToPeer(peer.nodeId, {
                    type: 'tx_log_request',
                    payload: { sinceSeq },
                    timestamp: Date.now()
                });
                if (!ok) {
                    console.log(`⚠️  Ledger sync send failed: ${peer.nodeId}`);
                }
            }
        };
        setTimeout(request, 1000);
        this.ledgerSyncInterval = setInterval(request, 5000);
    }

    startPendingTxRelay() {
        if (this.pendingTxInterval) {
            clearInterval(this.pendingTxInterval);
        }
        const tick = () => {
            if (!this.node || !this.ledger || this.isLedgerLeader()) return;
            const now = Date.now();
            for (const [txId, item] of this.pendingTxs.entries()) {
                if (this.ledger.getTxById(txId)) {
                    this.pendingTxs.delete(txId);
                    continue;
                }
                if (item.nextRetryAt && now < item.nextRetryAt) {
                    continue;
                }
                const targetLeader = this.consensus?.leaderId;
                if (targetLeader) {
                    const ok = this.node.sendToPeer(targetLeader, {
                        type: 'tx',
                        payload: item.tx,
                        timestamp: Date.now()
                    });
                    if (!ok) {
                        this.node.broadcastAll({
                            type: 'tx',
                            payload: item.tx,
                            timestamp: Date.now()
                        });
                    }
                } else {
                    this.node.broadcastAll({
                        type: 'tx',
                        payload: item.tx,
                        timestamp: Date.now()
                    });
                }
                item.attempts += 1;
                item.nextRetryAt = now + Math.min(2000 * item.attempts, 15000);
            }
        };
        this.pendingTxInterval = setInterval(tick, 2000);
    }

    importWallet(payload) {
        if (!this.options?.dataDir) {
            throw new Error('Missing dataDir for wallet import');
        }
        if (this.ledger && this.options.isGenesisNode) {
            const masterPub = this.ledger.getMeta('master_pubkey');
            const incomingPriv = payload?.account?.privateKeyPem || payload?.privateKeyPem || payload?.account?.privateKey;
            if (masterPub && incomingPriv) {
                const derivedPub = crypto.createPublicKey(crypto.createPrivateKey(incomingPriv)).export({ type: 'spki', format: 'pem' });
                if (derivedPub !== masterPub) {
                    throw new Error('Genesis wallet cannot be changed after initialization');
                }
            } else if (masterPub) {
                throw new Error('Genesis wallet cannot be changed after initialization');
            }
        }
        const wallet = importWallet(this.options.dataDir, payload);
        this.wallet = wallet;
        if (this.taskBazaar) {
            this.taskBazaar.walletAccountId = wallet.accountId;
        }
        return wallet;
    }

    setupEventHandlers() {
        // 监听新记忆
        this.node.on('memory:received', async (capsule) => {
            console.log(`📦 New capsule received: ${capsule.asset_id}`);
            await this.memoryStore.storeCapsule(capsule);
        });
        
        // 监听新任务
        this.node.on('task:received', async (task) => {
            console.log(`🎯 New task received: ${task.taskId}`);
            await this.taskBazaar.handleNewTask(task);
        });
        
        // 监听任务竞价
        this.node.on('task:bid', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, bid } = payload;
                console.log(`💰 Bid received for task: ${taskId?.slice(0, 16)} from ${bid?.nodeId?.slice(0, 16)}`);
                if (taskId && bid) {
                    const task = this.taskBazaar.getTask(taskId);
                    if (task) {
                        if (task.status === 'assigned' || task.status === 'completed') {
                            return;
                        }
                        task.bids = task.bids || [];
                        // Avoid duplicate bids
                        if (!task.bids.find(b => b.nodeId === bid.nodeId)) {
                            task.bids.push(bid);
                            this.taskBazaar.updateTask(taskId, { 
                                bids: task.bids,
                                status: task.status === 'open' ? 'voting' : task.status,
                                votingStartedAt: task.votingStartedAt || bid.timestamp || Date.now()
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Error handling task:bid:', err.message);
            }
        });

        this.node.on('task:assigned', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, assignedTo, assignedAt } = payload;
                if (!taskId || !assignedTo) return;
                const updatedTask = this.taskBazaar.updateTask(taskId, { 
                    status: 'assigned',
                    assignedTo,
                    assignedAt: assignedAt || Date.now()
                });
                if (this.taskWorker?.biddingTasks) {
                    this.taskWorker.biddingTasks.delete(taskId);
                }
                if (assignedTo === this.options.nodeId && updatedTask) {
                    if (!this.options.acceptTasks) {
                        console.log(`🛑 Ignore assignment ${taskId?.slice(0, 16)} (task receiving disabled)`);
                        return;
                    }
                    await this.taskWorker.startWorkingOnTask(updatedTask);
                }
            } catch (err) {
                console.error('Error handling task:assigned:', err.message);
            }
        });
        
        // 监听任务完成
        this.node.on('task:completed', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, nodeId, result, package: taskPackage } = payload;
                console.log(`✅ Task completed by node: ${nodeId?.slice(0, 16)} for task: ${taskId?.slice(0, 16)}`);
                if (taskId) {
                    this.taskBazaar.updateTask(taskId, { 
                        status: 'completed',
                        completedBy: nodeId,
                        completedAt: result?.completedAt || Date.now(),
                        result
                    });
                    const task = this.taskBazaar.getTask(taskId);
                    const assignedAt = task?.assignedAt ? Number(task.assignedAt) : null;
                    const completedAtRaw = result?.completedAt || Date.now();
                    const completedAt = Number(completedAtRaw) || Date.parse(completedAtRaw) || Date.now();
                    if (assignedAt && completedAt && completedAt >= assignedAt) {
                        const duration = completedAt - assignedAt;
                        this.ratingStore?.recordCompletion(nodeId, duration);
                    }
                }
                if (taskId && nodeId && taskPackage?.data) {
                    const completedBasePath = path.join(path.resolve(__dirname, '..'), 'task-workspace', 'completed');
                    const completedDir = path.join(completedBasePath, `${nodeId}_${taskId}`);
                    await fs.mkdir(completedDir, { recursive: true });
                    const fileName = taskPackage.fileName || (taskId + '.zip');
                    const zipPath = path.join(completedDir, fileName);
                    const zipBuffer = Buffer.from(taskPackage.data, 'base64');
                    await fs.writeFile(zipPath, zipBuffer);
                }
            } catch (err) {
                console.error('Error handling task:completed:', err.message);
            }
        });

        this.node.on('task:failed', async (payload) => {
            try {
                if (!payload) return;
                const { taskId, nodeId } = payload;
                if (taskId) {
                    this.taskBazaar.updateTask(taskId, { status: 'failed' });
                }
                if (nodeId) {
                    this.ratingStore?.recordFailure(nodeId);
                }
            } catch (err) {
                console.error('Error handling task:failed:', err.message);
            }
        });

        this.node.on('task:like', async (payload) => {
            try {
                const { taskId, winnerNodeId, likedBy, delta } = payload || {};
                if (!taskId || !winnerNodeId) return;
                this.ratingStore?.addVote(taskId, winnerNodeId, likedBy, Number(delta || 0));
            } catch (err) {
                console.error('Error handling task:like:', err.message);
            }
        });
        
        // 监听节点连接
        this.node.on('peer:connected', (peerId) => {
            console.log(`🌐 Peer connected: ${peerId}`);
            if (!this.isLedgerLeader()) {
                console.log(`🔄 Ledger sync request (on connect): sinceSeq=0 -> ${peerId}`);
                const ok = this.node.sendToPeer(peerId, {
                    type: 'tx_log_request',
                    payload: { sinceSeq: 0 },
                    timestamp: Date.now()
                });
                if (!ok) {
                    console.log(`⚠️  Ledger sync send failed (on connect): ${peerId}`);
                }
            }
        });
        
        // 监听节点断开
        this.node.on('peer:disconnected', (peerId) => {
            console.log(`🔌 Peer disconnected: ${peerId}`);
        });
        
        // 监听交易广播
        this.node.on('tx:received', (tx) => {
            if (!tx) return;
            if (this.isLedgerLeader()) {
                this.proposeTx(tx);
            } else if (this.isCoreNode() && this.consensus.leaderId) {
                this.node.sendToPeer(this.consensus.leaderId, {
                    type: 'tx',
                    payload: tx,
                    timestamp: Date.now()
                });
            }
        });

        this.node.on('raft:request_vote', (payload, peerId) => {
            this.onRaftRequestVote(payload, peerId);
        });
        this.node.on('raft:request_vote_response', (payload, peerId) => {
            this.onRaftRequestVoteResponse(payload, peerId);
        });
        this.node.on('raft:append_entries', (payload, peerId) => {
            this.onRaftAppendEntries(payload, peerId);
        });
        this.node.on('raft:append_entries_response', (payload, peerId) => {
            this.onRaftAppendEntriesResponse(payload, peerId);
        });
        
        // 监听交易日志同步
        this.node.on('tx:log', (entry) => {
            if (!entry) return;
            this.ledger.applyLogEntry(entry);
            if (entry.txId) {
                this.pendingTxs.delete(entry.txId);
            }
            if (this.taskBazaar?.tryActivatePendingTasks) {
                this.taskBazaar.tryActivatePendingTasks();
            }
        });

        // 监听账本同步请求（任意节点可响应）
        this.node.on('tx:log_request', (payload, peerId) => {
            const sinceSeq = Number(payload?.sinceSeq || 0);
            const limit = Number(payload?.limit || 500);
            console.log(`📥 tx_log_request from ${peerId} sinceSeq=${sinceSeq} limit=${limit}`);
            const entries = this.ledger.getTxLogSince(sinceSeq, limit);
            if (entries.length === 0) {
                console.log(`📤 tx_log_batch -> ${peerId} sinceSeq=${sinceSeq} count=0`);
                return;
            }
            const lastSeq = entries[entries.length - 1]?.seq || sinceSeq;
            console.log(`📤 tx_log_batch -> ${peerId} sinceSeq=${sinceSeq} count=${entries.length} lastSeq=${lastSeq}`);
            this.node.sendToPeer(peerId, {
                type: 'tx_log_batch',
                payload: { entries, lastSeq, hasMore: entries.length >= limit },
                timestamp: Date.now()
            });
        });
        
        // 监听账本批量同步
        this.node.on('tx:log_batch', (payload, peerId) => {
            const entries = payload?.entries || [];
            if (entries.length > 0) {
                const firstSeq = entries[0]?.seq;
                const lastSeq = entries[entries.length - 1]?.seq;
                console.log(`📥 tx_log_batch from ${peerId} count=${entries.length} seq=${firstSeq}..${lastSeq}`);
            }
            for (const entry of entries) {
                this.ledger.applyLogEntry(entry);
                if (entry?.txId) {
                    this.pendingTxs.delete(entry.txId);
                }
            }
            if (payload?.hasMore && Number.isFinite(payload?.lastSeq)) {
                this.node.sendToPeer(peerId, {
                    type: 'tx_log_request',
                    payload: { sinceSeq: Number(payload.lastSeq) },
                    timestamp: Date.now()
                });
            }
            if (this.taskBazaar?.tryActivatePendingTasks) {
                this.taskBazaar.tryActivatePendingTasks();
            }
        });

        this.node.on('ledger:head_request', (payload, peerId) => {
            this.node.sendToPeer(peerId, {
                type: 'ledger_head_response',
                payload: {
                    headHash: this.ledger.getHeadHash(),
                    lastSeq: this.ledger.getLastSeq(),
                    isGenesis: !!this.options.isGenesisNode
                },
                timestamp: Date.now()
            });
        });

        // ledger_head_* handlers are no longer used in forced tx_log sync mode.
    }
    
    createSignedTransfer(toAccountId, amount) {
        const nonce = this.ledger.getNonce(this.wallet.accountId) + 1;
        const payload = {
            type: 'transfer',
            from: this.wallet.accountId,
            to: toAccountId,
            amount: Number(amount),
            nonce,
            timestamp: Date.now()
        };
        const signature = signPayload(this.wallet.privateKeyPem, payload);
        return {
            ...payload,
            pubkeyPem: this.wallet.publicKeyPem,
            signature,
            txId: crypto.createHash('sha256').update(JSON.stringify({ ...payload, signature })).digest('hex')
        };
    }

    getPlatformAccountId() {
        const masterPub = this.ledger.getMeta('master_pubkey');
        if (!masterPub) return null;
        return accountIdFromPublicKey(masterPub);
    }

    async waitForPlatformAccount(timeoutMs = 8000, intervalMs = 200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const platform = this.getPlatformAccountId();
            if (platform) return platform;
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return null;
    }

    async waitForTxConfirmations(txId, target = 1, timeoutMs = 8000, intervalMs = 200) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const confirmations = this.ledger.getConfirmations(txId);
            if (confirmations >= target) {
                return { confirmed: true, confirmations };
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return { confirmed: false, confirmations: this.ledger.getConfirmations(txId) };
    }

    getConfirmConfig(action) {
        const target = this.options.txConfirmations?.[action] ?? 1;
        const timeoutMs = this.options.txTimeoutMs?.[action] ?? 8000;
        return { target, timeoutMs };
    }

    getTxStatus(txId) {
        const confirmations = this.ledger.getConfirmations(txId);
        return { txId, confirmations, confirmed: confirmations > 0 };
    }

    createSignedEscrowRelease(escrowAccountId, toAccountId, amount) {
        const nonce = this.ledger.getNonce(escrowAccountId) + 1;
        const payload = {
            type: 'escrow_release',
            from: escrowAccountId,
            to: toAccountId,
            amount: Number(amount),
            nonce,
            timestamp: Date.now()
        };
        const signature = signPayload(this.wallet.privateKeyPem, payload);
        return {
            ...payload,
            pubkeyPem: this.wallet.publicKeyPem,
            signature,
            txId: crypto.createHash('sha256').update(JSON.stringify({ ...payload, signature })).digest('hex')
        };
    }

    getEscrowAccountId(taskId) {
        const hash = crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 24);
        return `escrow_${hash}`;
    }

    isCoreNode() {
        return !!this.options.isGenesisNode;
    }

    isLedgerLeader() {
        return this.isCoreNode() && this.consensus.role === 'leader' && this.consensus.leaderId === this.options.nodeId;
    }

    startRaftConsensus() {
        if (!this.isCoreNode()) return;
        this.resetElectionDeadline();
        this.consensus.electionInterval = setInterval(() => {
            if (!this.isCoreNode()) return;
            if (this.isLedgerLeader()) return;
            if (Date.now() < this.consensus.electionDeadlineAt) return;
            this.startElection();
        }, 200);
        this.consensus.heartbeatInterval = setInterval(() => {
            if (!this.isLedgerLeader()) return;
            if (this.hasPendingReplication()) {
                this.replicateAll();
            } else {
                this.sendHeartbeats();
            }
        }, 900);
    }

    startElection() {
        this.consensus.role = 'candidate';
        this.consensus.term += 1;
        this.consensus.votedFor = this.options.nodeId;
        this.consensus.leaderId = null;
        this.consensus.votes = new Set([this.options.nodeId]);
        this.persistConsensusState(true);
        this.resetElectionDeadline();
        const { lastLogIndex, lastLogTerm } = this.getLastLogMeta();
        const payload = {
            term: this.consensus.term,
            candidateId: this.options.nodeId,
            lastLogIndex,
            lastLogTerm
        };
        const voters = this.getVoterNodeIds();
        for (const voterId of voters) {
            if (voterId === this.options.nodeId) continue;
            this.node.sendToPeer(voterId, {
                type: 'raft_request_vote',
                payload,
                timestamp: Date.now()
            });
        }
        if (this.consensus.votes.size >= this.getMajorityCount()) {
            this.becomeLeader();
        }
    }

    becomeLeader() {
        this.consensus.role = 'leader';
        this.consensus.leaderId = this.options.nodeId;
        this.consensus.votedFor = this.options.nodeId;
        const next = this.consensus.log.length + 1;
        this.consensus.nextIndex = new Map();
        this.consensus.matchIndex = new Map();
        this.consensus.replicationInFlight = new Set();
        this.consensus.replicationInFlightAt = new Map();
        const voters = this.getVoterNodeIds();
        for (const voterId of voters) {
            if (voterId === this.options.nodeId) continue;
            this.consensus.nextIndex.set(voterId, next);
            this.consensus.matchIndex.set(voterId, 0);
        }
        this.persistConsensusState();
        console.log(`👑 Leader elected: ${this.options.nodeId} (term=${this.consensus.term})`);
        this.replicateAll();
    }

    stepDownToFollower(term, leaderId = null) {
        if (Number.isFinite(Number(term)) && Number(term) > this.consensus.term) {
            this.consensus.term = Number(term);
        }
        this.consensus.role = 'follower';
        this.consensus.votedFor = null;
        this.consensus.votes = new Set();
        this.consensus.replicationInFlight = new Set();
        this.consensus.replicationInFlightAt = new Map();
        if (leaderId) {
            this.consensus.leaderId = leaderId;
        }
        this.persistConsensusState(true);
        this.resetElectionDeadline();
    }

    isCandidateLogUpToDate(lastLogIndex, lastLogTerm) {
        const local = this.getLastLogMeta();
        if (Number(lastLogTerm || 0) > local.lastLogTerm) return true;
        if (Number(lastLogTerm || 0) < local.lastLogTerm) return false;
        return Number(lastLogIndex || 0) >= local.lastLogIndex;
    }

    onRaftRequestVote(payload, peerId) {
        if (!this.isCoreNode() || !payload || !peerId) return;
        const term = Number(payload.term || 0);
        const candidateId = payload.candidateId;
        let voteGranted = false;
        if (term < this.consensus.term) {
            voteGranted = false;
        } else {
            if (term > this.consensus.term) {
                this.stepDownToFollower(term, null);
            }
            const canVote = !this.consensus.votedFor || this.consensus.votedFor === candidateId;
            const upToDate = this.isCandidateLogUpToDate(payload.lastLogIndex, payload.lastLogTerm);
            if (canVote && upToDate) {
                this.consensus.votedFor = candidateId;
                this.persistConsensusState(true);
                this.resetElectionDeadline();
                voteGranted = true;
            }
        }
        this.node.sendToPeer(peerId, {
            type: 'raft_request_vote_response',
            payload: {
                term: this.consensus.term,
                voterId: this.options.nodeId,
                voteGranted
            },
            timestamp: Date.now()
        });
    }

    onRaftRequestVoteResponse(payload) {
        if (!this.isCoreNode() || !payload) return;
        const term = Number(payload.term || 0);
        if (term > this.consensus.term) {
            this.stepDownToFollower(term, null);
            return;
        }
        if (this.consensus.role !== 'candidate') return;
        if (term !== this.consensus.term) return;
        if (!payload.voteGranted) return;
        this.consensus.votes.add(payload.voterId);
        if (this.consensus.votes.size >= this.getMajorityCount()) {
            this.becomeLeader();
        }
    }

    onRaftAppendEntries(payload, peerId) {
        if (!this.isCoreNode() || !payload || !peerId) return;
        const term = Number(payload.term || 0);
        if (term < this.consensus.term) {
            this.node.sendToPeer(peerId, {
                type: 'raft_append_entries_response',
                payload: { term: this.consensus.term, success: false, nextIndex: this.consensus.log.length + 1 },
                timestamp: Date.now()
            });
            return;
        }
        if (term > this.consensus.term || this.consensus.role !== 'follower') {
            this.stepDownToFollower(term, payload.leaderId || peerId);
        }
        this.consensus.leaderId = payload.leaderId || peerId;
        this.resetElectionDeadline();

        const prevLogIndex = Number(payload.prevLogIndex || 0);
        const prevLogTerm = Number(payload.prevLogTerm || 0);
        if (prevLogIndex > this.consensus.log.length) {
            this.node.sendToPeer(peerId, {
                type: 'raft_append_entries_response',
                payload: { term: this.consensus.term, success: false, nextIndex: this.consensus.log.length + 1 },
                timestamp: Date.now()
            });
            return;
        }
        if (prevLogIndex > 0) {
            const localPrev = this.consensus.log[prevLogIndex - 1];
            if (!localPrev || Number(localPrev.term) !== prevLogTerm) {
                const rollbackTo = Math.max(1, prevLogIndex);
                this.consensus.log = this.consensus.log.slice(0, rollbackTo - 1);
                this.consensus.commitIndex = Math.min(this.consensus.commitIndex, this.consensus.log.length);
                this.consensus.lastApplied = Math.min(this.consensus.lastApplied, this.consensus.commitIndex);
                this.persistConsensusState();
                this.node.sendToPeer(peerId, {
                    type: 'raft_append_entries_response',
                    payload: { term: this.consensus.term, success: false, nextIndex: rollbackTo },
                    timestamp: Date.now()
                });
                return;
            }
        }

        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        let changed = false;
        for (let i = 0; i < entries.length; i++) {
            const incoming = entries[i];
            const atIndex = prevLogIndex + i + 1;
            const local = this.consensus.log[atIndex - 1];
            if (local && Number(local.term) !== Number(incoming.term || 0)) {
                this.consensus.log = this.consensus.log.slice(0, atIndex - 1);
                changed = true;
            }
            if (!this.consensus.log[atIndex - 1]) {
                this.consensus.log.push({
                    index: atIndex,
                    term: Number(incoming.term || 0),
                    txId: incoming.txId || incoming.tx?.txId || null,
                    tx: incoming.tx
                });
                changed = true;
            }
        }
        if (changed) {
            this.persistConsensusState();
        }

        const leaderCommit = Number(payload.leaderCommit || 0);
        if (leaderCommit > this.consensus.commitIndex) {
            this.consensus.commitIndex = Math.min(leaderCommit, this.consensus.log.length);
            this.applyCommittedLogEntries(false);
            this.persistConsensusState();
        }

        this.node.sendToPeer(peerId, {
            type: 'raft_append_entries_response',
            payload: {
                term: this.consensus.term,
                success: true,
                matchIndex: prevLogIndex + entries.length,
                nextIndex: prevLogIndex + entries.length + 1
            },
            timestamp: Date.now()
        });
    }

    onRaftAppendEntriesResponse(payload, peerId) {
        if (!this.isCoreNode() || !payload || !peerId) return;
        if (!this.isLedgerLeader()) return;
        this.consensus.replicationInFlight.delete(peerId);
        this.consensus.replicationInFlightAt.delete(peerId);
        const term = Number(payload.term || 0);
        if (term > this.consensus.term) {
            this.stepDownToFollower(term, null);
            return;
        }
        if (term !== this.consensus.term) return;
        if (!payload.success) {
            const fallbackNext = Math.max(1, Number(payload.nextIndex || 1));
            this.consensus.nextIndex.set(peerId, fallbackNext);
            this.replicateToPeer(peerId, { force: true });
            return;
        }
        const matchIndex = Number(payload.matchIndex || 0);
        this.consensus.matchIndex.set(peerId, matchIndex);
        this.consensus.nextIndex.set(peerId, matchIndex + 1);
        if (this.consensus.nextIndex.get(peerId) <= this.consensus.log.length) {
            this.replicateToPeer(peerId, { force: true });
        }
        this.advanceCommitIndex();
    }

    replicateAll() {
        if (!this.isLedgerLeader()) return;
        const voters = this.getVoterNodeIds();
        for (const voterId of voters) {
            if (voterId === this.options.nodeId) continue;
            this.replicateToPeer(voterId);
        }
    }

    hasPendingReplication() {
        if (!this.isLedgerLeader()) return false;
        for (const peerId of this.getVoterNodeIds()) {
            if (peerId === this.options.nodeId) continue;
            const nextIndex = this.consensus.nextIndex.get(peerId) || (this.consensus.log.length + 1);
            if (nextIndex <= this.consensus.log.length) return true;
        }
        return false;
    }

    sendHeartbeats() {
        if (!this.isLedgerLeader()) return;
        for (const peerId of this.getVoterNodeIds()) {
            if (peerId === this.options.nodeId) continue;
            this.replicateToPeer(peerId, { heartbeatOnly: true, force: true });
        }
    }

    replicateToPeer(peerId, options = {}) {
        if (!this.isLedgerLeader()) return;
        const { heartbeatOnly = false, force = false } = options;
        if (!force && this.consensus.replicationInFlight.has(peerId)) {
            const sentAt = this.consensus.replicationInFlightAt.get(peerId) || 0;
            if (Date.now() - sentAt < 2200) {
                return;
            }
            this.consensus.replicationInFlight.delete(peerId);
            this.consensus.replicationInFlightAt.delete(peerId);
        }
        const nextIndex = this.consensus.nextIndex.get(peerId) || (this.consensus.log.length + 1);
        const prevLogIndex = nextIndex - 1;
        const prevLogTerm = prevLogIndex > 0 ? Number(this.consensus.log[prevLogIndex - 1]?.term || 0) : 0;
        let entries = this.consensus.log.slice(nextIndex - 1, nextIndex - 1 + 100).map(e => ({
            index: e.index,
            term: e.term,
            txId: e.txId,
            tx: e.tx
        }));
        if (heartbeatOnly) {
            entries = [];
        }
        if (!force && entries.length === 0 && !heartbeatOnly) return;
        if (entries.length > 0) {
            this.consensus.replicationInFlight.add(peerId);
            this.consensus.replicationInFlightAt.set(peerId, Date.now());
        }
        this.node.sendToPeer(peerId, {
            type: 'raft_append_entries',
            payload: {
                term: this.consensus.term,
                leaderId: this.options.nodeId,
                prevLogIndex,
                prevLogTerm,
                entries,
                leaderCommit: this.consensus.commitIndex
            },
            timestamp: Date.now()
        });
    }

    advanceCommitIndex() {
        if (!this.isLedgerLeader()) return;
        const majority = this.getMajorityCount();
        for (let n = this.consensus.log.length; n > this.consensus.commitIndex; n--) {
            const entry = this.consensus.log[n - 1];
            if (!entry || Number(entry.term) !== this.consensus.term) continue;
            let replicated = 1; // self
            for (const [peerId, match] of this.consensus.matchIndex.entries()) {
                if (match >= n) {
                    replicated += 1;
                }
            }
            if (replicated >= majority) {
                this.consensus.commitIndex = n;
                this.applyCommittedLogEntries(true);
                this.persistConsensusState();
                break;
            }
        }
    }

    applyCommittedLogEntries(broadcastTxLog = false) {
        while (this.consensus.lastApplied < this.consensus.commitIndex) {
            const index = this.consensus.lastApplied + 1;
            const entry = this.consensus.log[index - 1];
            if (!entry || !entry.tx) {
                this.consensus.lastApplied = index;
                continue;
            }
            const existing = this.ledger.getTxById(entry.txId || entry.tx.txId);
            let seq = existing?.seq || null;
            if (!existing) {
                const result = this.ledger.appendAsMaster(entry.tx);
                if (!result.accepted) {
                    console.error(`❌ Failed to apply committed log index=${index}: ${result.reason}`);
                    break;
                }
                seq = result.seq;
            }
            this.consensus.lastApplied = index;
            if (broadcastTxLog && seq) {
                this.node.broadcastAll({
                    type: 'tx_log',
                    payload: {
                        seq,
                        txId: entry.tx.txId,
                        type: entry.tx.type,
                        from: entry.tx.from,
                        to: entry.tx.to,
                        amount: entry.tx.amount,
                        nonce: entry.tx.nonce,
                        timestamp: entry.tx.timestamp,
                        pubkeyPem: entry.tx.pubkeyPem,
                        signature: entry.tx.signature
                    },
                    timestamp: Date.now()
                });
            }
        }
    }

    proposeTx(tx) {
        if (!tx) return { submitted: false, reason: 'Missing tx' };
        if (!this.isLedgerLeader()) return { submitted: false, reason: 'Not leader', leaderId: this.consensus.leaderId || null };
        const entry = {
            index: this.consensus.log.length + 1,
            term: this.consensus.term,
            txId: tx.txId,
            tx
        };
        this.consensus.log.push(entry);
        this.persistConsensusState();
        this.advanceCommitIndex(); // single-node cluster can commit immediately
        this.replicateAll();
        return { submitted: true, accepted: true, txId: tx.txId };
    }

    submitTx(tx) {
        if (!tx) return { submitted: false, reason: 'Missing tx' };
        if (this.isLedgerLeader()) {
            return this.proposeTx(tx);
        }
        if (this.consensus.leaderId) {
            const ok = this.node.sendToPeer(this.consensus.leaderId, {
                type: 'tx',
                payload: tx,
                timestamp: Date.now()
            });
            if (ok) {
                this.pendingTxs.set(tx.txId, { tx, attempts: 0, nextRetryAt: Date.now() + 1500 });
                return { submitted: true, accepted: true, txId: tx.txId, relayedTo: this.consensus.leaderId };
            }
        }
        this.node.broadcastAll({
            type: 'tx',
            payload: tx,
            timestamp: Date.now()
        });
        this.pendingTxs.set(tx.txId, { tx, attempts: 0, nextRetryAt: Date.now() + 1500 });
        return { submitted: true, accepted: true, txId: tx.txId };
    }

    // 发布记忆胶囊
    async publishCapsule(capsule) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        if (!capsule.price) {
            capsule.price = {
                amount: this.options.capsulePriceDefault,
                token: 'CLAW',
                creatorShare: this.options.capsuleCreatorShare
            };
        } else if (typeof capsule.price.creatorShare !== 'number') {
            capsule.price.creatorShare = this.options.capsuleCreatorShare;
        }

        // 添加创建者信息
        const creator = capsule.attribution?.creator || this.options.nodeId;
        capsule.attribution = {
            creator,
            created_at: new Date().toISOString()
        };
        
        // 计算asset_id
        capsule.asset_id = this.computeAssetId(capsule);

        const txReceipts = [];
        if (this.options.capsulePublishFee > 0) {
            const feeAmount = Number(this.options.capsulePublishFee);
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < feeAmount) {
                throw new Error('Insufficient balance to publish capsule');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const feeTx = this.createSignedTransfer(platformAccountId, feeAmount);
            const feeResult = this.submitTx(feeTx);
            if (this.isLedgerLeader() && !feeResult.accepted) {
                throw new Error(feeResult.reason || 'Failed to pay publish fee');
            }
            const cfg = this.getConfirmConfig('capsulePublish');
            const feeConfirm = await this.waitForTxConfirmations(feeTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ txId: feeTx.txId, ...feeConfirm });
        }
        
        // 本地存储
        await this.memoryStore.storeCapsule(capsule);
        
        // 广播到网络
        const capsuleMeta = {
            ...capsule,
            content: null,
            contentHash: capsule.asset_id
        };
        await this.node.broadcastCapsule(capsuleMeta);
        
        console.log(`✅ Capsule published: ${capsule.asset_id}`);
        return { assetId: capsule.asset_id, txReceipts };
    }
    
    // 发布任务
    async publishTask(task) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        
        task.publisher = task.publisher || this.options.nodeId;
        task.published_at = new Date().toISOString();
        task.taskId = this.computeTaskId(task);
        task.escrowAccountId = this.getEscrowAccountId(task.taskId);

        const txReceipts = [];
        if (this.options.taskPublishFee > 0) {
            const feeAmount = Number(this.options.taskPublishFee);
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < feeAmount) {
                throw new Error('Insufficient balance to publish task');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const feeTx = this.createSignedTransfer(platformAccountId, feeAmount);
            const feeResult = this.submitTx(feeTx);
            if (this.isLedgerLeader() && !feeResult.accepted) {
                throw new Error(feeResult.reason || 'Failed to pay task publish fee');
            }
            const cfg = this.getConfirmConfig('taskPublish');
            const feeConfirm = await this.waitForTxConfirmations(feeTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ type: 'task_publish_fee', txId: feeTx.txId, ...feeConfirm });
        }

        const bountyAmount = Number(task.bounty?.amount || 0);
        if (bountyAmount > 0) {
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < bountyAmount) {
                throw new Error('Insufficient balance to lock escrow');
            }
            const escrowTx = this.createSignedTransfer(task.escrowAccountId, bountyAmount);
            const escrowResult = this.submitTx(escrowTx);
            if (this.isLedgerLeader() && !escrowResult.accepted) {
                throw new Error(escrowResult.reason || 'Failed to lock escrow');
            }
            const cfg = this.getConfirmConfig('taskEscrow');
            const escrowConfirm = await this.waitForTxConfirmations(escrowTx.txId, cfg.target, cfg.timeoutMs);
            txReceipts.push({ type: 'task_escrow_lock', txId: escrowTx.txId, ...escrowConfirm });
        }

        const taskId = await this.taskBazaar.publishTask(task);
        await this.node.broadcastTask(task);
        console.log(`🎯 Task published: ${taskId}`);
        return { taskId, txReceipts };
    }

    async purchaseCapsule(assetId, buyerNodeId = null) {
        if (!this.initialized) {
            throw new Error('Mesh not initialized');
        }
        const buyer = buyerNodeId || this.options.nodeId;
        const capsule = this.memoryStore.getCapsule(assetId);
        if (!capsule) {
            throw new Error('Capsule not found');
        }
        const price = capsule.price?.amount || 0;
        if (price > 0 && buyer !== capsule.attribution?.creator) {
            const share = typeof capsule.price?.creatorShare === 'number' ? capsule.price.creatorShare : this.options.capsuleCreatorShare;
            const creatorAmount = Math.floor(price * share);
            const platformAmount = price - creatorAmount;
            const available = this.ledger.getBalance(this.wallet.accountId);
            if (available < price) {
                throw new Error('Insufficient balance to purchase capsule');
            }
            const platformAccountId = await this.waitForPlatformAccount();
            if (!platformAccountId) {
                throw new Error('Platform account not available yet');
            }
            const txReceipts = [];
            const toCreatorTx = creatorAmount > 0 ? this.createSignedTransfer(capsule.attribution.creator, creatorAmount) : null;
            const toPlatformTx = platformAmount > 0 ? this.createSignedTransfer(platformAccountId, platformAmount) : null;
            if (toCreatorTx) {
                const res1 = this.submitTx(toCreatorTx);
                if (this.isLedgerLeader() && !res1.accepted) {
                    throw new Error(res1.reason || 'Failed to pay creator');
                }
                const cfg = this.getConfirmConfig('capsulePurchase');
                const conf1 = await this.waitForTxConfirmations(toCreatorTx.txId, cfg.target, cfg.timeoutMs);
                txReceipts.push({ txId: toCreatorTx.txId, ...conf1 });
            }
            if (toPlatformTx) {
                const res2 = this.submitTx(toPlatformTx);
                if (this.isLedgerLeader() && !res2.accepted) {
                    throw new Error(res2.reason || 'Failed to pay platform');
                }
                const cfg = this.getConfirmConfig('capsulePurchase');
                const conf2 = await this.waitForTxConfirmations(toPlatformTx.txId, cfg.target, cfg.timeoutMs);
                txReceipts.push({ txId: toPlatformTx.txId, ...conf2 });
            }
            return { capsule, txReceipts };
        }
        return { capsule, txReceipts: [] };
    }
    
    // 提交任务解决方案
    async submitSolution(taskId, solution) {
        const result = await this.taskBazaar.submitSolution(taskId, solution, this.options.nodeId);
        if (result?.winner && this.isLedgerLeader()) {
            const task = this.taskBazaar.getTask(taskId);
            const escrowId = task?.escrowAccountId;
            const bounty = task?.bounty?.amount || 0;
            if (escrowId && bounty > 0) {
                const releaseTx = this.createSignedEscrowRelease(escrowId, result.winnerId, bounty);
                this.submitTx(releaseTx);
            }
        }
        return result;
    }
    
    // 获取网络统计
    getStats() {
        return {
            nodeId: this.options.nodeId,
            peers: this.node.getPeers(),
            leaderId: this.consensus?.leaderId || null,
            isLedgerLeader: this.isLedgerLeader(),
            role: this.consensus?.role || 'follower',
            term: this.consensus?.term || 0,
            commitIndex: this.consensus?.commitIndex || 0,
            lastApplied: this.consensus?.lastApplied || 0,
            memoryCount: this.memoryStore.getCount(),
            taskCount: this.taskBazaar.getTaskCount(),
            uptime: process.uptime()
        };
    }
    
    // 同步网络记忆
    async syncMemories(filter = {}) {
        console.log('🔄 Syncing memories from network...');
        const memories = await this.node.queryMemories(filter);
        for (const capsule of memories) {
            await this.memoryStore.storeCapsule(capsule);
        }
        console.log(`✅ Synced ${memories.length} memories`);
        return memories.length;
    }
    
    computeAssetId(capsule) {
        const crypto = require('crypto');
        const content = JSON.stringify(capsule.content);
        return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    }
    
    computeTaskId(task) {
        const crypto = require('crypto');
        const content = task.description + task.publisher + task.published_at;
        return 'task_' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    
    // 关闭
    async stop() {
        console.log('👋 Stopping OpenClaw Mesh...');
        
        if (this.webUI) {
            await this.webUI.stop();
        }
        
        if (this.node) {
            await this.node.stop();
        }
        
        if (this.memoryStore) {
            await this.memoryStore.close();
        }

        if (this.ledger) {
            this.ledger.close();
        }

        if (this.ratingStore) {
            this.ratingStore.close();
        }

        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        if (this.ledgerSyncInterval) {
            clearInterval(this.ledgerSyncInterval);
        }
        if (this.pendingTxInterval) {
            clearInterval(this.pendingTxInterval);
        }
        if (this.consensus?.electionInterval) {
            clearInterval(this.consensus.electionInterval);
        }
        if (this.consensus?.heartbeatInterval) {
            clearInterval(this.consensus.heartbeatInterval);
        }
        if (this.consensusPersistTimer) {
            clearTimeout(this.consensusPersistTimer);
            this.consensusPersistTimer = null;
        }
        this.persistConsensusState(true);
        await this.flushConsensusState();
        
        console.log('✅ OpenClaw Mesh stopped');
    }
}

module.exports = OpenClawMesh;
