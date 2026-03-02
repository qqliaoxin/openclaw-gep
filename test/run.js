/**
 * OpenClaw GEP 测试套件
 */

const OpenClawMesh = require('../src/index');
const MemoryStore = require('../src/memory-store');
const MeshNode = require('../src/node');
const TaskBazaar = require('../src/task-bazaar');

// 测试配置
const TEST_CONFIG = {
    nodeId: 'node_test_' + Date.now(),
    port: 0,
    webPort: 9999,
    dataDir: './test/data'
};

// 简单的测试框架
class TestRunner {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
    }
    
    test(name, fn) {
        this.tests.push({ name, fn });
    }
    
    async run() {
        console.log('\n🧪 OpenClaw GEP Test Suite\n');
        console.log('='.repeat(60));
        
        for (const { name, fn } of this.tests) {
            try {
                await fn();
                console.log(`✅ ${name}`);
                this.passed++;
            } catch (e) {
                console.log(`❌ ${name}`);
                console.log(`   Error: ${e.message}`);
                this.failed++;
            }
        }
        
        console.log('='.repeat(60));
        console.log(`\nResults: ${this.passed} passed, ${this.failed} failed`);
        
        return this.failed === 0;
    }
}

const runner = new TestRunner();

// 测试1: MemoryStore 初始化
runner.test('MemoryStore.init() - should create database', async () => {
    const store = new MemoryStore(TEST_CONFIG.dataDir);
    await store.init();
    
    const stats = store.getStats();
    if (!stats || typeof stats.total !== 'number') {
        throw new Error('Failed to get stats');
    }
    
    await store.close();
});

// 测试2: MemoryStore 存储和检索
runner.test('MemoryStore.storeCapsule() - should store and retrieve', async () => {
    const store = new MemoryStore(TEST_CONFIG.dataDir);
    await store.init();
    
    const capsule = {
        asset_id: 'sha256:test123',
        content: {
            gene: { trigger: 'test', solution: 'test solution' },
            capsule: { type: 'skill', confidence: 0.9 }
        },
        attribution: { creator: 'node_test', created_at: new Date().toISOString() }
    };
    
    await store.storeCapsule(capsule);
    const retrieved = store.getCapsule('sha256:test123');
    
    if (!retrieved || retrieved.asset_id !== 'sha256:test123') {
        throw new Error('Failed to retrieve capsule');
    }
    
    await store.close();
});

// 测试3: MemoryStore 查询
runner.test('MemoryStore.queryCapsules() - should filter by type', async () => {
    const store = new MemoryStore(TEST_CONFIG.dataDir);
    await store.init();
    
    const capsules = store.queryCapsules({ type: 'skill', limit: 10 });
    
    if (!Array.isArray(capsules)) {
        throw new Error('Query should return array');
    }
    
    await store.close();
});

// 测试4: TaskBazaar 发布任务
runner.test('TaskBazaar.publishTask() - should create task', async () => {
    const bazaar = new TaskBazaar({
        nodeId: 'node_test',
        memoryStore: null
    });
    
    const task = {
        description: 'Test task',
        type: 'code',
        bounty: { amount: 100, token: 'CLAW' }
    };
    
    const taskId = await bazaar.publishTask(task);
    
    if (!taskId || !taskId.startsWith('task_')) {
        throw new Error('Invalid task ID');
    }
    
    const retrieved = bazaar.getTask(taskId);
    if (!retrieved || retrieved.description !== 'Test task') {
        throw new Error('Failed to retrieve task');
    }
});

// 测试5: TaskBazaar 提交解决方案
runner.test('TaskBazaar.submitSolution() - should accept valid solution', async () => {
    const bazaar = new TaskBazaar({
        nodeId: 'node_test',
        memoryStore: null
    });
    
    const task = {
        description: 'Test task',
        type: 'code',
        bounty: { amount: 100, token: 'CLAW' }
    };
    
    const taskId = await bazaar.publishTask(task);
    
    const solution = {
        description: 'Test solution',
        code: 'function test() { return true; }'
    };
    
    const result = await bazaar.submitSolution(taskId, solution, 'node_solver');
    
    if (!result.success) {
        throw new Error('Solution should be accepted');
    }
});

// 测试6: 计算asset_id
runner.test('OpenClawMesh.computeAssetId() - should generate consistent hash', async () => {
    const mesh = new OpenClawMesh(TEST_CONFIG);
    
    const capsule = {
        content: { test: 'data' }
    };
    
    const id1 = mesh.computeAssetId(capsule);
    const id2 = mesh.computeAssetId(capsule);
    
    if (id1 !== id2) {
        throw new Error('Asset ID should be consistent');
    }
    
    if (!id1.startsWith('sha256:')) {
        throw new Error('Asset ID should start with sha256:');
    }
});

// 测试7: 完整的Mesh初始化
runner.test('OpenClawMesh.init() - should initialize all components', async () => {
    const mesh = new OpenClawMesh({
        ...TEST_CONFIG,
        webPort: 9998
    });
    
    await mesh.init();
    
    if (!mesh.initialized) {
        throw new Error('Mesh should be initialized');
    }
    
    if (!mesh.memoryStore || !mesh.node || !mesh.taskBazaar || !mesh.webUI) {
        throw new Error('All components should be initialized');
    }
    
    await mesh.stop();
});

// 运行测试
runner.run().then(success => {
    process.exit(success ? 0 : 1);
}).catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
