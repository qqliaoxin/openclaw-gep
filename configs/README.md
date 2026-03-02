# g1/g2/g3 配置模板

这 3 个配置用于：

- 主节点互联（`genesisNodes`）
- 固定投票成员（`consensusVoterIds`）
- 单创世 + 多路由主（仅 `g1` 启用 `bootstrapLedger: true`）

## 启动

```bash
./src/cli.js start --config ./configs/g1.json --no-task
./src/cli.js start --config ./configs/g2.json --no-task
./src/cli.js start --config ./configs/g3.json --no-task
```

## 跨机器部署需要改

- `advertiseHost`
- `genesisNodes` 里的地址
- 保持 3 个文件的 `consensusVoterIds` 完全一致
- 仅保留一个节点 `bootstrapLedger: true`
