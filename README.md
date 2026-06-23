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

## Canvas 样本采集指南

### 为什么需要多组样本

TES 会验证 `canvas_hash` 和 `histogramBins` 是否来自同一个 canvas 渲染。这两个值由 GPU 硬件、驱动版本、操作系统字体渲染决定，**不同设备/GPU 产生不同的配对数据**。

当前项目只有 1 组采集测试数据（Intel Iris Xe），如果所有注册号共享同一个 canvas 指纹，做关联分析，可以识别出批量注册行为。但对方采集 5-10 组不同设备的数据可以大幅提升隐蔽性。

### 采集工具

`source/collect_histogram.html` — 精确复现 canvas 渲染逻辑。

### 采集步骤

1. **在目标设备上用 Chrome 打开** `tools/collect_histogram.html`
   - 必须用 Chrome（和注册时模拟的浏览器一致）
   - 不同 GPU 的设备分别采集（台式机、笔记本、不同显卡）
   - 不要用无痕模式（某些扩展可能影响 canvas 渲染）

2. **页面会自动采集**，显示：
   - `canvas_hash` — signed int32，直接用于指纹
   - `histogramBins` — 256 个整数，canvas 像素颜色分布
   - 稳定性验证（同一设备多次采集结果应完全相同）

3. **点击"复制到剪贴板"**，得到 Python 格式的数据：
   ```python
   # canvas_hash = -1436970477
   # 直接粘贴到 _CANVAS_DATA_POOL
   (-1436970477, [
        13542, 70, 90, 41, 53, 53, 39, 49, 44, 42, 48, 37, 37, 18, 57, 72,
        ...
   ]),
   ```

4. **粘贴到 `browser_identity.py`** 的 `_CANVAS_DATA_POOL` 列表中：
   ```python
   _CANVAS_DATA_POOL: list[tuple[int, list[int]]] = [
       # ── 样本 1: Intel Iris Xe ──
       (-1436970477, [ ... ]),
       # ── 样本 2: NVIDIA GTX 1060 (新增) ──
       (-987654321, [ ... ]),
       # ── 样本 3: AMD Radeon RX 580 (新增) ──
       (123456789, [ ... ]),
   ]
   ```

5. **同步更新 GPU 配置**（可选但推荐）：
   - 记录采集设备的 GPU 型号
   - 在 `_GPU_CONFIGS` 中添加对应的 `vendor` / `model`
   - 在 `BrowserIdentity.random()` 中实现 GPU ↔ Canvas 配对选择

### 单台设备 = 一个固定指纹

Canvas 渲染结果是**确定性的**。同一台电脑无论采集多少次，结果都完全相同。因为指纹取决于硬件和系统层面的因素：

| 因素 | 影响方式 | 变化频率 |
|------|---------|---------|
| GPU 型号 | 渲染管线/着色器不同 | 换显卡才变 |
| GPU 驱动版本 | 浮点精度/抗锯齿实现差异 | 更新驱动可能变 |
| 操作系统 | 字体渲染引擎 (DirectWrite/FreeType) | Win/Mac/Linux 各不同 |
| 字体库 | Arial 的具体 hinting | 基本不变 |
| DPI 缩放 | 亚像素渲染策略变化 | 改缩放比例会变 |
| Chrome 版本 | Skia 渲染引擎更新 | 大版本升级可能变 |

因此，**一台电脑只能产生一组有效样本**。要获取多组样本，有两个途径：

1. **不同设备采集** — 找朋友/同事的电脑，不同 GPU 型号效果最好
2. **同设备改 DPI** — 在 Windows 设置中切换缩放比例 (100% → 125% → 150%)，同一台机器可能产生 2-3 组不同数据（需实测验证）

### 采集注意事项

- **必须配对**: `canvas_hash` 和 `histogramBins` 必须来自同一次渲染，不能混搭
- **同设备稳定**: 同一设备 + 同一 Chrome 版本，多次采集结果应**完全相同**。如果不同，说明有扩展干扰
- **不同设备不同**: 不同 GPU / 不同操作系统的结果一定不同，这正是我们需要多组数据的原因
- **Chrome 版本影响**: 大版本升级可能改变 canvas 渲染结果，建议用当前模拟的版本 (Chrome 137) 采集
- **屏幕缩放影响**: Windows 的 DPI 缩放 (125%/150%) 可能影响结果，记录缩放比例
- **批量采集**: 点击"批量采集 5 组"验证稳定性，如果 5 组完全相同说明该设备数据可靠

### 原理说明

`collect_histogram.html` 复现的 TES canvas 渲染步骤：

```
1. 创建 150×60 canvas
2. 绘制矩形 rect(0,0,10,10) + rect(2,2,20,20)
3. isPointInPath(5,5,"evenodd") 检测
4. 填充橙色矩形 fillRect(95,1,62,30)
5. 用 Arial 8pt/11pt 绘制 "Cwm fjordbank glyphs vext quiz,"
6. globalCompositeOperation = "multiply"
7. 绘制 3 个彩色圆 (RGB 255/0/255, 0/255/255, 255/255/0)
8. 用 "evenodd" 填充嵌套圆
9. 线性渐变 + 小圆
10. 用不存在的字体 "dfgstg" 绘制 Math.tan/cos/sin(-1e300)
11. 二次贝塞尔曲线路径
12. globalCompositeOperation = "difference" + 3 个圆
```

最终：
- `canvas_hash = CRC32("isPointInPath结果" + "~" + "canvas fp:" + toDataURL())`
- `histogramBins = 统计所有像素 RGBA 通道值的频率分布 (256 bins)`

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
  source/
    FINGERPRINT_GENERATION.md  真机如何生成每个指纹字段（检测对照基准）
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

