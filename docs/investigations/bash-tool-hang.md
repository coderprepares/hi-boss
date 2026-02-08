# BashTool 命令挂起问题排查报告

**日期**: 2026-02-08
**状态**: 已解决
**影响范围**: Claude Code SDK 集成层 (agent executor)

---

## 问题现象

Hi-Boss agent (cc) 通过 Claude Code SDK 执行 Bash 命令时，部分命令永久挂起直到超时：

- `pm2 list` — 永久挂起
- `echo hello` — 正常执行
- `hiboss envelope send` — 匹配 allowedTools 模式时正常执行

## 排查时间线

### 假设 1: 环境变量继承（部分正确，非根因）

**观察**: daemon 进程继承了父 Claude Code CLI 的环境变量：
- `CLAUDECODE=1`
- `CLAUDE_CODE_ENTRYPOINT=cli`

这导致子 CLI 认为自己嵌套在另一个 Claude Code 实例中。

**修复**: 在 `executor.ts` 的 env 配置中清除这些变量：

```typescript
env: {
  CLAUDE_CODE_ENTRYPOINT: undefined,
  CLAUDECODE: undefined,
}
```

**结果**: 修复了嵌套检测问题，但 `pm2 list` 仍然挂起。

### 假设 2: 权限系统阻塞（排除）

逐一尝试了以下配置，全部无效：

| 尝试方式 | 结果 |
|---------|------|
| `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions` | 无效 |
| `allowedTools: ["Bash(*)"]` | 无效 |
| `canUseTool` callback | 从未被调用 |
| `settings.json` 中 `permissions.defaultMode` | 无效 |

**结论**: 问题不在权限系统。

### 假设 3: Session resume 导致挂起（副作用，非根因）

**观察**: CLI 使用 `--resume` 恢复了一个过时的 session。

**处理**: 清理了数据库中的 session handle 和磁盘上的 session 文件。

**结果**: 新 session 创建成功，但 `pm2 list` 仍然挂起。

### 假设 4: allowedTools 模式匹配问题（排除）

分析 CLI 的 `CW()` 函数逻辑：`Bash(*)` 解析为 `{toolName: "Bash"}` 且无 ruleContent，即匹配所有 Bash 输入。

**结论**: `Bash(*)` 语义正确，不是问题所在。

### 关键突破: DEBUG 对比分析

启用 `DEBUG_CLAUDE_AGENT_SDK=1`，对比 `echo hello`（成功）和 `pm2 list`（失败）的 stderr debug 日志。

关键区别：

| 步骤 | echo hello | pm2 list |
|------|-----------|----------|
| PreToolUse hooks | 通过 | 通过 |
| Shell snapshot | 直接创建 | 未到达 |
| Pre-flight API 调用 | 跳过 | 调用 haiku 模型 |
| 命令执行 | 成功 | 未执行 |

## 根因

**Claude Code CLI (v2.1.29) 的 BashTool Pre-flight Safety Check 机制。**

对于非简单命令（不在内置安全列表中的），CLI 会调用 `claude-haiku-4-5-20251001` 模型来分析命令前缀，判断命令安全性。

`echo hello` 等简单命令通过快速路径跳过此检查，而 `pm2 list` 不在安全列表中，触发了 haiku API 调用。

### 具体失败链路

```
1. CLI 收到 LLM 返回的 tool_use: Bash "pm2 list"
2. CLI 调用 pre-flight check 函数 b5q()
3. b5q() 发送 API 请求到 claude-haiku-4-5-20251001（提取命令前缀）
4. API 请求发往 ANTHROPIC_BASE_URL (localhost:23000 本地 LLM 代理)
5. 本地代理不支持 haiku 模型 → 返回 503 "No available providers"
6. CLI 内置重试机制循环重试（最多 11 次，指数退避）
7. 所有重试均 503 → CLI 卡在 pre-flight check → 最终超时
```

### 验证

- 修复代理的模型映射后，haiku 请求可正常处理
- `pm2 list` 成功执行
- 但 pre-flight check 仍需约 30s（haiku 被路由到带 thinking 的模型）

## 结论

**不是 Hi-Boss 代码的 bug。** 问题出在本地 LLM 代理 (localhost:23000) 不支持 `claude-haiku-4-5-20251001` 模型请求，而 Claude Code CLI 的 BashTool pre-flight safety check 依赖该模型。

## 修复方案

1. **本地代理增加 haiku 模型支持（已修复）** — 添加模型映射使代理能正确路由 haiku 请求
2. **可选优化** — 设置 `ANTHROPIC_SMALL_FAST_MODEL` 环境变量指向更快的模型，减少 pre-flight check 耗时
3. **可选优化** — 在代理端对 haiku 请求禁用 thinking，将 pre-flight check 从 ~30s 降低到 <3s

## 排查中的临时更改（已回滚）

| 更改 | 是否需要 |
|------|---------|
| `permissionMode: "bypassPermissions"` | 不需要 |
| `allowDangerouslySkipPermissions: true` | 不需要 |
| `allowedTools: ["Bash(*)"]` | 不需要，原始 `Bash(hiboss:*)` 模式足够 |
| `MIN_TOOL_TIMEOUT_MS = 10_000` | 不需要 |
| TEMP DIAG 注入代码 | 不需要 |

## 有用的排查工具和方法

| 工具/方法 | 用途 |
|----------|------|
| `DEBUG_CLAUDE_AGENT_SDK=1` | 启用 CLI debug 输出到 stderr，**定位此问题的关键** |
| SDK query options 的 `stderr` callback | 捕获 CLI 的 debug 输出 |
| macOS `sample` 命令 | 确认 CLI 进程处于 idle 状态 |
| 自定义 `--require` 注入脚本 | 监控 CLI 的 stdin/stdout 通信 |
| 直接 SDK 调用绕过 daemon | 隔离问题层级 |

## 关键代码路径 (Claude Code CLI v2.1.29)

| 函数 | 作用 |
|------|------|
| `eO()` | 选择 pre-flight check 使用的模型：`ANTHROPIC_SMALL_FAST_MODEL` > `ANTHROPIC_DEFAULT_HAIKU_MODEL` > `claude-haiku-4-5-20251001` |
| `b5q()` | pre-flight check 主函数，调用 haiku 模型提取命令前缀 |
| `WtY()` | 安全列表检查，仅对 `--help` 结尾的命令返回 true |
| `CW()` | allowedTools 模式解析函数 |
| `fF1()` | 工具执行入口函数 |

## 经验总结

1. **当 SDK 集成出现部分命令正常、部分挂起时，优先检查 CLI 的隐式外部依赖**（如 pre-flight check 对辅助模型的调用）。
2. **`DEBUG_CLAUDE_AGENT_SDK=1` 是排查 Claude Code SDK 集成问题的第一优先级工具**，应在排查初期就启用。
3. **本地 LLM 代理必须支持 CLI 可能调用的所有模型**，不仅是主模型，还包括辅助模型（haiku 等）。
4. **对比成功和失败场景的 debug 日志**是定位分歧点的高效方法。
