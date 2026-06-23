# 指纹字段生成原理（真机地面真值）

本文记录**真实浏览器**如何产生每一个指纹字段，作为检测器的对照基准（ground truth）。检测器要判断一份上报是否伪造，前提是知道"真的长什么样、由什么决定、字段间有什么约束"。

## 范围说明

- ✅ **包含**：每个字段在真机里的真实产生机制、决定其取值的物理/平台因素、字段间的约束不变量，并映射到 `server/validate.js` 的检测点。
- ❌ **不包含**：离线合成假指纹的引擎、伪造采集耗时/交互/timing 的启发式、提交加密与密钥、模拟会话一致性的上下文管理器。这些属于规避机制，与"指纹如何生成"无关，故不收录。

字段分层见 `PRINCIPLE.md §0`：硬件层（会话内恒定）、环境层（SPA 内恒定）、行为层（每次变化）。

---

## 1. canvas hash —— 硬件层

**真机如何生成**：执行一段固定的 2D 绘制序列（矩形、文字、彩色圆、渐变、贝塞尔曲线、合成模式），然后
```
hash = CRC32( isPointInPath(5,5,"evenodd") 结果 + "~canvas fp:" + canvas.toDataURL() )
```
完整可运行的真机渲染见 `client/canvas_reference.html`。

**决定因素**：GPU 型号、GPU 驱动、操作系统字体渲染引擎、DPI 缩放、浏览器版本（Skia）。这些决定了 `toDataURL` 输出的像素字节，因此 hash 是**设备确定性**的——同机同浏览器每次结果完全一致。

**检测约束**：取值为 signed int32（CRC32 范围）。→ `checkStructure` 校验 `INT32_MIN ≤ hash ≤ INT32_MAX`。

---

## 2. canvas histogramBins —— 硬件层

**真机如何生成**：对同一次渲染的输出取 `getImageData(0,0,w,h)`，统计每个 RGBA 通道字节值（0–255）的出现频率：
```js
const data = ctx.getImageData(0, 0, 150, 60).data; // 长度 = 150×60×4
const hist = new Array(256).fill(0);
for (let i = 0; i < data.length; i++) hist[data[i]]++;
```

**决定因素**：与 canvas hash 同源——来自同一段像素数据。

**检测约束**：
- 恰好 256 个桶。→ `checkStructure` 校验 `bins.length === 256`。
- 所有桶求和 = 被统计的字节数 = `150×60×4 = 36000`（求和不变量）。→ `checkStructure` 校验 `sum === EXPECTED_HISTOGRAM_SUM`。

---

## 3. canvas hash ↔ histogram 绑定 —— 核心约束

**为什么成立**：hash 与 histogram 都从**同一次渲染输出**派生。真机上这对值必然一一对应且可复现；伪造方随机改其一，配对立即破裂。

**检测约束**：同一 hash 必须始终携带同一 histogram。→ `checkBinding` 用 FNV-1a 对整个桶序列做摘要 `{len, sum, dist}`，首见登记、再见比对，不一致即判伪造。对应 `PRINCIPLE.md §2`。

> 这是检测体系最强的一条约束：要么所有伪造账号共享一对真实值（被关联分析 §7 抓），要么随机配对（被本条抓），两条路都堵死。

---

## 4. GPU vendor / model —— 硬件层

**真机如何生成**：
```js
const gl = canvas.getContext('webgl');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
const model  = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
// 例: "Google Inc. (Intel)" / "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics ... Direct3D11 ...)"
```

**决定因素**：真实显卡 + 驱动 + 浏览器图形后端（Windows 上通常是 ANGLE/D3D11）。

**检测约束**：真机有具体型号串与非空扩展列表；无头/容器环境多为软件渲染。→ `checkAutomation` 命中 `SwiftShader/llvmpipe/Software`、空 WebGL 扩展列表。

---

## 5. WebGL 扩展列表 —— 硬件层

**真机如何生成**：`gl.getSupportedExtensions()` 返回该 GPU+驱动支持的扩展数组（真机通常 20+ 项，如 `EXT_blend_minmax`、`OES_texture_float`、`WEBGL_debug_renderer_info` 等）。

**检测约束**：真实 GPU 会暴露一组扩展。→ `checkAutomation` 对空数组加分。

---

## 6. Math 三角常量 —— 环境层（平台相关）

**真机如何生成**：`Math.tan(-1e300)`、`Math.sin(-1e300)`、`Math.cos(-1e300)`。极端输入下，结果由 JS 引擎的 libm 实现决定，因此**同平台+同引擎版本固定**，跨平台/跨引擎可能不同。

**检测用途**：可作为平台一致性的旁证（如声称某 UA 却给出不匹配该平台的 Math 值）。当前检测器未强制此项，列为可选扩展点。

---

## 7. screenInfo —— 硬件层

**真机如何生成**：`screen.width / screen.height / screen.availHeight / screen.colorDepth`，拼成 `"宽-高-可用高-色深-*-*-*"`。

**决定因素**：真实显示器分辨率、系统任务栏占用、色深（桌面通常 24）。

**检测约束**：会话内不应变化。→ `sessionSnapshot` 纳入 `screenInfo`，`checkSessionDrift` 比对突变。分辨率为 0 或非常规值是无显示器环境的信号。

---

## 8. plugins —— 环境层

**真机如何生成**：`Array.from(navigator.plugins).map(p => p.name)`。现代 Chrome 桌面端通常含 PDF 相关内置项。

**检测约束**：桌面 UA 却插件列表为空，是无头环境的常见特征。→ `checkAutomation` 对「桌面 UA + 空插件」组合加分。

---

## 9. performance.timing —— 环境层

**真机如何生成**：由导航生命周期自动填充，**不是脚本能自由设定的**。各时间点按真实网络/渲染过程先后落定：
```
navigationStart ≤ fetchStart ≤ domainLookupStart ≤ connectStart
              ≤ responseStart ≤ domInteractive ≤ loadEventEnd
```
且页面加载完成（`loadEventEnd`）应早于任何采集动作的发生时间。

**检测约束**：
- 上述顺序不可违反。→ `checkTiming` 按 `TIMING_ORDER` 逐项校验单调性。
- `loadEventEnd` 不应晚于采集 `start`。→ `checkTiming` 校验。
- 注意：`navigationStart` 是 wall-clock，**每次整页加载都会变**，故**不纳入**会话快照，否则会误判刷新为突变（见 `validate.js` 注释）。

---

## 10. 交互计数（interaction）—— 行为层

**真机如何生成**：通过事件监听在页面生命周期内累积，例如：
```js
addEventListener('click',   () => { clicks++; positions.push(`${e.clientX},${e.clientY}`); }, true);
addEventListener('keydown', () => { const dt = now - last; if (dt>0) intervals.push(dt); keyPresses++; }, true);
```
按键间隔来自真实击键时刻差，带自然抖动。

**检测约束**：
- 页面刚加载（PageLoad）时用户尚未操作，计数应为 0。→ `checkBehavior` 对「PageLoad 却有交互」加分。
- 真人节奏：间隔有抖动、不为 0、`intervals 数量 < keyPresses`（连续快打部分间隔被合并）。→ `checkBehavior` 对全等间隔/0ms 间隔/数量矛盾加分。

---

## 11. 时间戳 start / end —— 行为层

**真机如何生成**：`Date.now()`，分别记于采集开始与结束。

**检测约束**：`start ≤ end`，且应接近服务器时间（容忍时钟漂移）。→ `checkStructure` 校验偏差，`checkTiming` 校验 `start ≤ end`。

---

## 12. 自动化信号 —— 环境层

**真机如何生成（应为否）**：
```js
navigator.webdriver           // 真机 false
window.phantom / __nightmare  // 真机不存在
window.cdc_... (CDP 残留变量)  // 真机不存在
/headless/i.test(userAgent)   // 真机不命中
```

**检测约束**：任一为真都是自动化环境信号。→ `checkAutomation` 逐项加分。

---

## 字段 → 检测项速查

| 字段 | 层 | 检测函数 | 约束 |
|------|----|----------|------|
| canvas hash | 硬件 | checkStructure / checkBinding | int32 + 绑定一致 |
| histogramBins | 硬件 | checkStructure / checkBinding | 256 桶 + 求和 36000 + 绑定一致 |
| GPU / WebGL 扩展 | 硬件 | checkAutomation / checkSessionDrift | 非软件渲染 + 非空 + 会话恒定 |
| screenInfo | 硬件 | checkSessionDrift | 会话恒定 |
| plugins | 环境 | checkAutomation | 桌面 UA 非空 |
| performance.timing | 环境 | checkTiming | 顺序单调 + 早于采集 |
| interaction | 行为 | checkBehavior | PageLoad 零交互 + 人类节奏 |
| start / end | 行为 | checkStructure / checkTiming | 近服务器时间 + start≤end |
| 自动化信号 | 环境 | checkAutomation | 全为否 |
