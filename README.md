# 浏览器指纹检测系统（TES 原理移植）

把 AWS TES（Trusted Environment Services）的指纹**检测思路**移植到自有网站，用于风控、反爬、反批量注册、异常会话识别。本目录站在**检测方**视角：客户端采集环境特征，服务端校验一致性并输出风险分。

## 它解决什么问题

普通的"采集一串指纹字符串"没有意义——攻击方可以伪造任意字段。TES 真正的价值在于**交叉校验**：让多个字段之间存在数学/物理约束，伪造一个字段就会破坏另一个字段，从而暴露。本系统复刻这套约束。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                         浏览器（客户端）                       │
│  client/fingerprint.js                                        │
│    ├─ 硬件层（会话内恒定）: canvas hash+histogram / GPU /      │
│    │                        math / screen / plugins           │
│    ├─ 环境层: navigator / performance.timing / automation     │
│    └─ 行为层（每次变化）: 点击/按键计数 / 时间戳 / 停留时长     │
└───────────────────────────────┬─────────────────────────────┘
                                 │  POST /collect  { payload }
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                         服务端（检测方）                       │
│  server/validate.js  —— 纯函数评分引擎，可移植到任意后端       │
│    ① 结构校验    histogram 256 桶 / 求和不变量                 │
│    ② 绑定一致性  同一 canvas hash 必须携带同一 histogram       │
│    ③ 会话稳定性  硬件字段在会话内不得突变                       │
│    ④ 自动化痕迹  webdriver / 软件渲染 / 空插件 / UA 矛盾        │
│    ⑤ 行为合理性  PageLoad 应零交互；提交应有人类节奏           │
│    ⑥ 时序连贯性  start<end / timing 顺序 / 停留时长合理         │
│    ⑦ 关联分析    同一指纹横跨过多账号 = 批量农场               │
│            ▼                                                   │
│     risk score 0-100  +  命中原因列表  +  low/mid/high 分级    │
└─────────────────────────────────────────────────────────────┘
```

## 目录

```
tes-plan/
  README.md            本文件：计划 + 架构 + 使用
  PRINCIPLE.md         检测原理：逐项说明每个校验维度的物理依据
  CANVAS_COLLECTOR.md  canvas 参考采集器使用说明
  client/
    fingerprint.js        浏览器采集器（无依赖，可直接 <script> 引入）
    canvas_reference.html  canvas 指纹参考采集器（为检测建立真机基线）
    demo.html             演示页：采集 → 上报 → 展示风险分
  server/
    validate.js        核心评分引擎（纯函数 + Validator 状态机，可移植）
    server.js          Express demo 服务（接收上报、返回风险评估）
    test.js            评分引擎自测（node test.js）
    package.json
```

## 快速开始

```bash
cd tes-plan/server
npm install
node server.js                 # 默认 http://localhost:8787
# 浏览器打开 http://localhost:8787/  即为 demo.html
```

> 本仓库约定不由 AI 启动 dev server，请自行执行上述命令。

## 落地到你自己的项目

1. **客户端**：把 `client/fingerprint.js` 引入页面，在关键动作（登录/注册/下单）前调用 `TESFingerprint.collect(eventType)`，把返回对象随业务请求一起上报。
2. **服务端**：把 `server/validate.js` 的 `Validator` 接入你的后端（Node 直接用；其它语言按 PRINCIPLE.md 的规则重写，逻辑全是纯计算）。
3. **存储**：示例用内存 Map 存指纹注册表与关联表。生产环境替换为 Redis/数据库，按 `clientId`（登录用户）或 cookie/设备 ID 维度持久化。
4. **决策**：根据 `riskLevel` 接入你的风控策略——high 触发二次验证（验证码/短信），mid 限流观察，low 放行。

## 设计原则

- **检测靠约束，不靠保密**：每个校验项都基于可解释的物理/数学约束，不依赖"算法不被人知道"。
- **可移植**：评分引擎是纯函数，输入 payload 输出分数，不绑定框架。
- **可解释**：每个风险分都附带命中原因，便于人工复核与调参。
- **渐进**：先上结构校验与自动化痕迹（零误杀），再逐步引入关联分析（需积累基线数据）。
