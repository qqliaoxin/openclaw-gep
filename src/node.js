/**
 * MeshNode - P2P网络节点
 * 基于简化版的Gossip协议实现
 */

const EventEmitter = require('events');
const net = require('net');
const crypto = require('crypto');

class MeshNode extends EventEmitter {
    constructor(options = {}) {
        super();
        this.nodeId = options.nodeId;
        this.port = options.port || 0;
        this.bootstrapNodes = options.bootstrapNodes || [];
        this.isGenesisNode = !!options.isGenesisNode;
        this.advertiseHost = options.advertiseHost || null;
        
        this.peers = new Map(); // peerId -> socket
        this.peerMeta = new Map(); // peerId -> { address, port, isGenesisNode, lastSeen }
        this.server = null;
        this.messageHandlers = new Map();
        this.seenMessages = new Map();
        this.seenTtlMs = options.seenTtlMs || 300000;
        this.maxSeenMessages = options.maxSeenMessages || 10000;
        this.peerStats = new Map();
        this.pendingPings = new Map();
        this.defaultFanout = options.fanout || 6;
        this.taskFanout = options.taskFanout || 8;
        this.defaultHops = options.defaultHops || 3;
        this.taskHops = options.taskHops || 4;
        this.routeSyncTimer = null;
        this.bootstrapRetryTimer = null;
        this.routeConnectBackoffMs = options.routeConnectBackoffMs || 30000;
        this.routeConnectAttempts = new Map(); // address -> nextAllowedAt
        
        this.setupMessageHandlers();
    }
    
    setupMessageHandlers() {
        // 处理新记忆胶囊
        this.messageHandlers.set('capsule', async (message, peerId) => {
            this.emit('memory:received', message.payload);
        });
        
        // 处理新任务
        this.messageHandlers.set('task', async (message, peerId) => {
            this.emit('task:received', message.payload);
        });
        
        // 处理任务竞价
        this.messageHandlers.set('task_bid', async (message, peerId) => {
            this.emit('task:bid', message.payload);
        });
        
        // 处理任务完成通知
        this.messageHandlers.set('task_completed', async (message, peerId) => {
            this.emit('task:completed', message.payload);
        });

        // 处理任务失败通知
        this.messageHandlers.set('task_failed', async (message, peerId) => {
            this.emit('task:failed', message.payload);
        });

        this.messageHandlers.set('task_assigned', async (message, peerId) => {
            this.emit('task:assigned', message.payload);
        });
        
        this.messageHandlers.set('task_like', async (message, peerId) => {
            this.emit('task:like', message.payload);
        });
        
        // 处理查询请求
        this.messageHandlers.set('query', async (message, peerId) => {
            const response = await this.handleQuery(message.payload);
            this.sendToPeer(peerId, {
                type: 'query_response',
                payload: response,
                requestId: message.requestId
            });
        });
        
        // 处理查询响应
        this.messageHandlers.set('query_response', async (message, peerId) => {
            this.emit(`query_response:${message.requestId}`, message.payload);
        });
        
        // 处理ping
        this.messageHandlers.set('ping', (message, peerId) => {
            const pong = {
                type: 'pong',
                timestamp: Date.now()
            };
            if (message.pingId) {
                pong.pingId = message.pingId;
            }
            this.sendToPeer(peerId, pong);
        });
        
        // 处理pong
        this.messageHandlers.set('pong', (message, peerId) => {
            if (message.pingId) {
                const pending = this.pendingPings.get(message.pingId);
                if (pending && pending.peerId === peerId) {
                    const rtt = Date.now() - pending.sentAt;
                    this.pendingPings.delete(message.pingId);
                    this.peerStats.set(peerId, { rtt, lastSeen: Date.now() });
                }
            }
            this.emit('peer:alive', peerId);
        });
        
        // 处理交易广播
        this.messageHandlers.set('tx', (message, peerId) => {
            this.emit('tx:received', message.payload, peerId);
        });

        // 处理交易日志广播
        this.messageHandlers.set('tx_log', (message, peerId) => {
            this.emit('tx:log', message.payload, peerId);
        });

        // 处理账本同步请求
        this.messageHandlers.set('tx_log_request', (message, peerId) => {
            this.emit('tx:log_request', message.payload, peerId);
        });

        // 处理账本批量同步
        this.messageHandlers.set('tx_log_batch', (message, peerId) => {
            this.emit('tx:log_batch', message.payload, peerId);
        });

        // 处理账本头hash请求
        this.messageHandlers.set('ledger_head_request', (message, peerId) => {
            this.emit('ledger:head_request', message.payload, peerId);
        });

        // 处理账本头hash响应
        this.messageHandlers.set('ledger_head_response', (message, peerId) => {
            this.emit('ledger:head_response', message.payload, peerId);
        });

        // 处理主节点路由同步
        this.messageHandlers.set('route_sync', (message, peerId) => {
            this.handleRouteSync(message.payload, peerId);
            this.emit('route:sync', message.payload, peerId);
        });

        // 选举: 请求投票
        this.messageHandlers.set('leader_vote_request', (message, peerId) => {
            this.emit('leader:vote_request', message.payload, peerId);
        });

        // 选举: 投票响应
        this.messageHandlers.set('leader_vote_response', (message, peerId) => {
            this.emit('leader:vote_response', message.payload, peerId);
        });

        // 选举: Leader 心跳
        this.messageHandlers.set('leader_heartbeat', (message, peerId) => {
            this.emit('leader:heartbeat', message.payload, peerId);
        });

        // 选举: Leader 宣告
        this.messageHandlers.set('leader_announce', (message, peerId) => {
            this.emit('leader:announce', message.payload, peerId);
        });

        // Raft: RequestVote
        this.messageHandlers.set('raft_request_vote', (message, peerId) => {
            this.emit('raft:request_vote', message.payload, peerId);
        });

        // Raft: RequestVoteResponse
        this.messageHandlers.set('raft_request_vote_response', (message, peerId) => {
            this.emit('raft:request_vote_response', message.payload, peerId);
        });

        // Raft: AppendEntries / heartbeat
        this.messageHandlers.set('raft_append_entries', (message, peerId) => {
            this.emit('raft:append_entries', message.payload, peerId);
        });

        // Raft: AppendEntriesResponse
        this.messageHandlers.set('raft_append_entries_response', (message, peerId) => {
            this.emit('raft:append_entries_response', message.payload, peerId);
        });
    }
    
    async init() {
        return new Promise((resolve, reject) => {
            // 创建服务器
            this.server = net.createServer((socket) => {
                this.handleConnection(socket);
            });
            
            this.server.listen(this.port, () => {
                const address = this.server.address();
                this.port = address.port;
                console.log(`📡 P2P node listening on port ${this.port}`);
                
                // 连接到bootstrap节点
                this.connectToBootstrapNodes();
                
                // 启动心跳
                this.startHeartbeat();
                this.startBootstrapReconnect();
                this.startRouteSync();
                
                resolve();
            });
            
            this.server.on('error', reject);
        });
    }
    
    handleConnection(socket) {
        let buffer = '';
        let peerId = null;
        
        // Store socket immediately by remote address (temporary key)
        const remoteKey = socket.remoteAddress + ':' + socket.remotePort;
        this.peers.set(remoteKey, socket);
        
        socket.on('data', (data) => {
            buffer += data.toString();
            
            // 处理消息（按行分割）
            let lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整行
            
            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const message = JSON.parse(line);
                        if (message.type === 'handshake' && message.nodeId) {
                            peerId = message.nodeId;
                            const socket = this.peers.get(remoteKey);
                            if (socket) {
                                this.peers.delete(remoteKey);
                                this.peers.set(peerId, socket);
                                console.log(`✅ handshake mapped socket for ${peerId} (inbound)`);
                            }
                            this.updatePeerMeta(peerId, socket, message);
                        }
                        this.handleMessage(message, peerId || remoteKey);
                    } catch (e) {
                        console.error('Invalid message:', e.message);
                    }
                }
            }
        });
        
        socket.on('close', () => {
            if (peerId) {
                this.peers.delete(peerId);
                this.peerMeta.delete(peerId);
                this.emit('peer:disconnected', peerId);
            }
            // Also remove by remote key
            this.peers.delete(remoteKey);
        });
        
        socket.on('error', (err) => {
            console.error('Socket error:', err.message);
        });
    }
    
    handleMessage(message, peerId) {
        // 更新peerId（如果是handshake消息）
        if (message.type === 'handshake') {
            const oldKey = peerId; // Could be remoteKey or address like "localhost:4001"
            
            // If peerId already looks like a nodeId (starts with node_), skip
            if (!oldKey.startsWith('node_')) {
                peerId = message.nodeId;
                
                // Update socket mapping - replace old key with nodeId
                const socket = this.peers.get(oldKey);
                if (socket) {
                    const existing = this.peers.get(peerId);
                    if (existing && existing !== socket) {
                        if (existing.writable && !existing.destroyed) {
                            // Keep existing stable connection, close duplicate
                            try { socket.destroy(); } catch (e) {}
                            return;
                        }
                    }
                    this.peers.delete(oldKey);
                    this.peers.set(peerId, socket);
                    this.updatePeerMeta(peerId, socket, message);
                    
                    // Send handshake back for bidirectional connection (only if not already sent)
                    if (!oldKey.includes(this.nodeId)) {
                        this.send(socket, {
                            type: 'handshake',
                            nodeId: this.nodeId,
                            port: this.port,
                            isGenesisNode: this.isGenesisNode,
                            host: this.advertiseHost
                        });
                    }
                }
            } else {
                peerId = message.nodeId;
                const socket = this.peers.get(peerId);
                if (socket) {
                    this.updatePeerMeta(peerId, socket, message);
                }
            }
            const mapped = this.peers.get(peerId);
            if (!mapped) {
                console.log(`⚠️  handshake mapped but socket missing for ${peerId} (oldKey=${oldKey})`);
            } else {
                console.log(`✅ handshake mapped socket for ${peerId}`);
            }
            this.emit('peer:connected', peerId);
        }

        if (!this.shouldProcessMessage(message)) {
            return;
        }
        if (message && (message.type === 'tx_log_request' || message.type === 'tx_log_batch')) {
            console.log(`⬅️  recv ${message.type} from ${peerId}`);
        }
        
        const handler = this.messageHandlers.get(message.type);
        if (handler) {
            handler(message, peerId);
        }

        if (this.shouldRelayMessage(message)) {
            this.relayMessage(message, peerId);
        }
    }
    
    getSocketForPeer(peerId) {
        // Find socket by peerId - check peers Map first, then by iterating sockets
        if (this.peers.has(peerId)) {
            return this.peers.get(peerId);
        }
        // Fallback: try to find by remote address/ip
        for (const [id, sock] of this.peers) {
            if (id.includes(peerId) || peerId.includes(id)) {
                return sock;
            }
        }
        return null;
    }
    
    async connectToBootstrapNodes() {
        for (const addr of this.bootstrapNodes) {
            try {
                await this.connectToPeer(addr);
            } catch (e) {
                console.error(`Failed to connect to bootstrap ${addr}:`, e?.message || String(e) || 'unknown error');
            }
        }
    }

    startBootstrapReconnect() {
        if (this.bootstrapRetryTimer) {
            clearInterval(this.bootstrapRetryTimer);
        }
        const tick = () => {
            const now = Date.now();
            for (const addr of this.bootstrapNodes) {
                if (!addr || typeof addr !== 'string') continue;
                const alreadyByAddress = this.peers.has(addr);
                const alreadyByMeta = Array.from(this.peerMeta.values()).some(meta => meta?.address === addr);
                if (alreadyByAddress || alreadyByMeta) continue;
                const nextAllowedAt = this.routeConnectAttempts.get(addr) || 0;
                if (now < nextAllowedAt) continue;
                this.routeConnectAttempts.set(addr, now + 5000);
                this.connectToPeer(addr).catch((e) => {
                    const msg = e?.message || String(e) || 'unknown error';
                    console.error(`Retry connect bootstrap ${addr} failed: ${msg}`);
                });
            }
        };
        setTimeout(tick, 1500);
        this.bootstrapRetryTimer = setInterval(tick, 5000);
    }
    
    async connectToPeer(address) {
        return new Promise((resolve, reject) => {
            if (this.peers.has(address)) {
                return resolve();
            }
            const [host, port] = address.split(':');
            const socket = net.createConnection({ host, port: parseInt(port) }, () => {
                // Store temporarily by address
                this.peers.set(address, socket);
                
                // 发送handshake
                this.send(socket, {
                    type: 'handshake',
                    nodeId: this.nodeId,
                    port: this.port,
                    isGenesisNode: this.isGenesisNode,
                    host: this.advertiseHost
                });
                
                console.log(`🔗 Connected to peer: ${address}`);
                resolve();
            });
            
            // Handle incoming messages on this outgoing connection
            let buffer = '';
            socket.on('data', (data) => {
                buffer += data.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const message = JSON.parse(line);
                            // Handle peer handshake response - update peer mapping
                            if (message.type === 'handshake' && message.nodeId) {
                                // Remove old address key, add nodeId
                                this.peers.delete(address);
                                this.peers.set(message.nodeId, socket);
                                console.log(`🔄 Mapped peer: ${message.nodeId}`);
                                this.updatePeerMeta(message.nodeId, socket, message, host);
                            }
                            this.handleMessage(message, message.nodeId || address);
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });
            
            socket.on('error', reject);
            
            socket.on('close', () => {
                this.peers.delete(address);
                for (const [peerId, meta] of this.peerMeta.entries()) {
                    if (meta && meta.address === address) {
                        this.peerMeta.delete(peerId);
                    }
                }
            });
        });
    }
    
    send(socket, message) {
        if (socket && !socket.destroyed && socket.writable) {
            if (message && (message.type === 'tx_log_request' || message.type === 'tx_log_batch')) {
                console.log(`➡️  send ${message.type} to ${socket.remoteAddress || 'peer'}:${socket.remotePort || ''}`);
            }
            socket.write(JSON.stringify(message) + '\n');
        }
    }
    
    sendToPeer(peerId, message) {
        const socket = this.peers.get(peerId) || this.getSocketForPeer(peerId);
        if (socket && !socket.destroyed) {
            if (!socket.writable) {
                console.log(`⚠️  peer socket not writable: ${peerId}`);
                return false;
            }
            this.send(socket, message);
            return true;
        }
        console.log(`⚠️  missing peer socket: ${peerId}`);
        // Clean up stale peer
        this.peers.delete(peerId);
        return false;
    }
    
    // 广播胶囊到所有peer
    async broadcastCapsule(capsule) {
        const message = {
            type: 'capsule',
            payload: capsule,
            timestamp: Date.now()
        };
        this.broadcast(message, { fanout: this.defaultFanout, hopsLeft: this.defaultHops });
    }
    
    // 广播任务
    async broadcastTask(task) {
        const message = {
            type: 'task',
            payload: task,
            timestamp: Date.now()
        };
        this.broadcast(message, { fanout: this.taskFanout, hopsLeft: this.taskHops });
    }
    
    broadcast(message, options = {}) {
        const { fanout, excludePeerId, hopsLeft } = options;
        const peers = this.selectPeers(fanout || this.defaultFanout, excludePeerId);
        const messageId = this.ensureMessageId(message);
        this.markMessageSeen(messageId);
        for (const { peerId, socket } of peers) {
            try {
                if (socket && !socket.destroyed) {
                    const outbound = {
                        ...message,
                        messageId,
                        hopsLeft: typeof hopsLeft === 'number' ? hopsLeft : this.defaultHops
                    };
                    this.send(socket, outbound);
                } else {
                    this.peers.delete(peerId);
                }
            } catch (e) {
                console.error(`Failed to send to ${peerId}:`, e.message);
                this.peers.delete(peerId);
            }
        }
    }

    broadcastAll(message, options = {}) {
        const { excludePeerId, hopsLeft } = options;
        const messageId = this.ensureMessageId(message);
        this.markMessageSeen(messageId);
        for (const [peerId, socket] of this.peers) {
            if (excludePeerId && peerId === excludePeerId) continue;
            try {
                if (socket && !socket.destroyed) {
                    const outbound = {
                        ...message,
                        messageId,
                        hopsLeft: typeof hopsLeft === 'number' ? hopsLeft : this.defaultHops
                    };
                    this.send(socket, outbound);
                } else {
                    this.peers.delete(peerId);
                }
            } catch (e) {
                console.error(`Failed to send to ${peerId}:`, e.message);
                this.peers.delete(peerId);
            }
        }
    }
    
    // 查询网络中的记忆
    async queryMemories(filter = {}) {
        const requestId = crypto.randomUUID();
        const query = {
            type: 'query',
            payload: { type: 'memories', filter },
            requestId
        };
        
        // 发送查询到所有peer
        this.broadcastAll(query, { hopsLeft: 0 });
        
        // 等待响应（简化版，实际应该设置超时）
        return new Promise((resolve) => {
            const results = [];
            const timeout = setTimeout(() => resolve(results), 5000);
            
            this.once(`query_response:${requestId}`, (response) => {
                clearTimeout(timeout);
                resolve(response.memories || []);
            });
        });
    }
    
    async handleQuery(query) {
        // 本地查询（实际应该查询memory store）
        if (query.type === 'memories') {
            return { memories: [] };
        }
        return {};
    }
    
    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            for (const [pingId, pending] of this.pendingPings) {
                if (now - pending.sentAt > 15000) {
                    this.pendingPings.delete(pingId);
                }
            }
            for (const [peerId, socket] of this.peers) {
                if (socket && !socket.destroyed) {
                    const pingId = crypto.randomUUID();
                    this.pendingPings.set(pingId, { peerId, sentAt: now });
                    this.send(socket, { type: 'ping', timestamp: now, pingId });
                } else {
                    // Remove stale peer
                    this.peers.delete(peerId);
                }
            }
        }, 30000); // 每30秒发送一次心跳
    }

    startRouteSync() {
        if (this.routeSyncTimer) {
            clearInterval(this.routeSyncTimer);
        }
        const tick = () => {
            if (!this.isGenesisNode) return;
            const routes = this.getKnownGenesisRoutes();
            if (routes.length === 0) return;
            this.broadcastAll({
                type: 'route_sync',
                payload: { routes, source: this.nodeId },
                timestamp: Date.now()
            }, { hopsLeft: this.defaultHops });
        };
        setTimeout(tick, 2000);
        this.routeSyncTimer = setInterval(tick, 15000);
    }

    updatePeerMeta(peerId, socket, handshake = {}, fallbackHost = null) {
        if (!peerId || !socket) return;
        const rawHost = handshake?.host || fallbackHost || socket.remoteAddress || '';
        const host = String(rawHost).replace('::ffff:', '') || '127.0.0.1';
        const announcedPort = Number(handshake?.port);
        const port = Number.isFinite(announcedPort) && announcedPort > 0 ? announcedPort : null;
        const address = port ? `${host}:${port}` : null;
        const current = this.peerMeta.get(peerId) || {};
        this.peerMeta.set(peerId, {
            ...current,
            address: address || current.address || null,
            port: port || current.port || null,
            isGenesisNode: handshake?.isGenesisNode === true || current.isGenesisNode === true,
            lastSeen: Date.now()
        });
    }

    getKnownGenesisRoutes() {
        const routes = [];
        if (this.isGenesisNode && this.port && this.advertiseHost) {
            routes.push({
                nodeId: this.nodeId,
                address: `${this.advertiseHost}:${this.port}`,
                isGenesisNode: true
            });
        }
        for (const [peerId, meta] of this.peerMeta.entries()) {
            if (!meta?.isGenesisNode || !meta?.address) continue;
            routes.push({
                nodeId: peerId,
                address: meta.address,
                isGenesisNode: true
            });
        }
        const unique = new Map();
        for (const route of routes) {
            if (!route.address) continue;
            unique.set(route.address, route);
        }
        return Array.from(unique.values());
    }

    handleRouteSync(payload, fromPeerId) {
        const routes = Array.isArray(payload?.routes) ? payload.routes : [];
        if (routes.length === 0) return;
        const now = Date.now();
        for (const route of routes) {
            const nodeId = route?.nodeId;
            const address = route?.address;
            if (!address || typeof address !== 'string') continue;
            if (nodeId && nodeId === this.nodeId) continue;
            if (!route?.isGenesisNode) continue;
            if (nodeId && this.peers.has(nodeId)) continue;
            if (this.peers.has(address)) continue;
            const nextAllowedAt = this.routeConnectAttempts.get(address) || 0;
            if (now < nextAllowedAt) continue;
            this.routeConnectAttempts.set(address, now + this.routeConnectBackoffMs);
            this.connectToPeer(address).catch(() => {});
        }
        if (fromPeerId && this.isGenesisNode) {
            const myRoutes = this.getKnownGenesisRoutes();
            if (myRoutes.length > 0) {
                this.sendToPeer(fromPeerId, {
                    type: 'route_sync',
                    payload: { routes: myRoutes, source: this.nodeId },
                    timestamp: Date.now()
                });
            }
        }
    }
    
    getPeers() {
        const peers = [];
        for (const [peerId, socket] of this.peers) {
            const id = peerId;
            peers.push({
                nodeId: id,
                ip: socket.remoteAddress ? socket.remoteAddress.replace('::ffff:', '') : 'unknown',
                connectedAt: Date.now()
            });
        }
        return peers;
    }

    getGenesisPeerIds() {
        const ids = [];
        for (const [peerId, meta] of this.peerMeta.entries()) {
            if (!peerId || !String(peerId).startsWith('node_')) continue;
            if (meta?.isGenesisNode) {
                ids.push(peerId);
            }
        }
        return ids;
    }

    ensureMessageId(message) {
        if (!message.messageId) {
            message.messageId = crypto.randomUUID();
        }
        return message.messageId;
    }

    markMessageSeen(messageId) {
        if (!messageId) return;
        this.seenMessages.set(messageId, Date.now());
        this.cleanupSeenMessages();
    }

    cleanupSeenMessages() {
        const now = Date.now();
        for (const [messageId, seenAt] of this.seenMessages) {
            if (now - seenAt > this.seenTtlMs) {
                this.seenMessages.delete(messageId);
            }
        }
        while (this.seenMessages.size > this.maxSeenMessages) {
            const oldest = this.seenMessages.keys().next().value;
            if (!oldest) break;
            this.seenMessages.delete(oldest);
        }
    }

    shouldProcessMessage(message) {
        if (!message || !message.messageId) {
            return true;
        }
        if (this.seenMessages.has(message.messageId)) {
            return false;
        }
        this.markMessageSeen(message.messageId);
        return true;
    }

    shouldRelayMessage(message) {
        if (!message || !message.messageId) return false;
        if (message.type === 'handshake') return false;
        if (message.type === 'ping' || message.type === 'pong') return false;
        if (message.type === 'query' || message.type === 'query_response') return false;
        if (typeof message.hopsLeft !== 'number') return true;
        return message.hopsLeft > 0;
    }

    relayMessage(message, fromPeerId) {
        const nextHops = typeof message.hopsLeft === 'number' ? message.hopsLeft - 1 : this.defaultHops - 1;
        if (nextHops < 0) return;
        const fanout = message.type === 'task' ? this.taskFanout : this.defaultFanout;
        this.broadcast(message, {
            fanout,
            excludePeerId: fromPeerId,
            hopsLeft: nextHops
        });
    }

    selectPeers(fanout, excludePeerId) {
        const peers = [];
        for (const [peerId, socket] of this.peers) {
            if (excludePeerId && peerId === excludePeerId) continue;
            if (!socket || socket.destroyed) {
                this.peers.delete(peerId);
                continue;
            }
            const stats = this.peerStats.get(peerId);
            peers.push({ peerId, socket, rtt: stats?.rtt });
        }
        const withStats = peers.filter(p => typeof p.rtt === 'number');
        const withoutStats = peers.filter(p => typeof p.rtt !== 'number');
        withStats.sort((a, b) => a.rtt - b.rtt);
        for (let i = withoutStats.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [withoutStats[i], withoutStats[j]] = [withoutStats[j], withoutStats[i]];
        }
        const ordered = [...withStats, ...withoutStats];
        if (!fanout || fanout >= ordered.length) {
            return ordered;
        }
        return ordered.slice(0, fanout);
    }
    
    async stop() {
        if (this.bootstrapRetryTimer) {
            clearInterval(this.bootstrapRetryTimer);
            this.bootstrapRetryTimer = null;
        }
        if (this.routeSyncTimer) {
            clearInterval(this.routeSyncTimer);
            this.routeSyncTimer = null;
        }
        // 关闭所有peer连接
        for (const [peerId, socket] of this.peers) {
            socket.destroy();
        }
        this.peers.clear();
        this.peerMeta.clear();
        
        // 关闭服务器
        if (this.server) {
            this.server.close();
        }
        
        console.log('📡 P2P node stopped');
    }
}

module.exports = MeshNode;
