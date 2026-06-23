# Canvas 指纹参考采集器使用说明

`client/canvas_reference.html` 复现一段**确定性 canvas 渲染流程**，计算其 `canvas_hash` 与 256 桶 `histogramBins`。它服务于检测引擎的「绑定一致性」校验（见 `PRINCIPLE.md` §2）——用它在**已知真机**上采集参考基线，从而判定线上上报的 hash↔histogram 配对是否来自真实渲染。

## 为什么检测方需要它

检测引擎的核心约束是：同一 `canvas_hash` 必须永远携带同一 `histogram`。要落地这条规则，需要先理解这对值是如何从一次渲染中**确定性派生**的：

- `canvas_hash = CRC32(isPointInPath 结果 + "~canvas fp:" + toDataURL())`
- `histogramBins = 渲染输出像素 RGBA 通道值的频率分布（256 桶）`

两者来自同一段像素数据，因此**真机上必然一一对应且可复现**。攻击方若随机伪造其一，配对立即被打破。本工具让你亲手验证这一点，并产出可录入检测系统的基线条目。

## 使用步骤

1. **在已知真机上用 Chrome 打开** `client/canvas_reference.html`
   - 用与线上检测一致的浏览器（如 Chrome）
   - 不要用无痕模式（部分扩展会干扰 canvas 渲染）

2. 页面自动采集并显示：
   - `canvas_hash` —— signed int32
   - 像素采样总数（应为 150×60×4 = 36000，即检测引擎的求和不变量）
   - 非零桶数、最大桶值、histogram[0]/[255]

3. 点击 **「采集 5 次（验证确定性）」**
   - 同一设备 5 次结果应**完全一致**。若不一致，说明有扩展干扰，该样本不可作为基线。

4. 点击 **「复制结果」**，得到 JSON 基线条目：
   ```json
   {
     "canvasHash": -1436970477,
     "histogramBins": [13542, 70, 90, ...],
     "ua": "Mozilla/5.0 ... Chrome/137.0 ...",
     "note": "已知真机参考基线"
   }
   ```

5. 把该条目录入检测系统的「已知真机」参考表。`server/validate.js` 的 `Validator` 首次见到某 hash 时会自动记录其 histogram 摘要；若你想预置可信基线，把这些条目在服务启动时灌入 `bindingRegistry` 即可。

## 渲染确定性的影响因素

canvas 渲染结果由硬件与系统层面决定，这正是它可作为设备指纹的原因：

| 因素 | 影响方式 | 变化频率 |
|------|---------|---------|
| GPU 型号 | 渲染管线/着色器差异 | 换显卡才变 |
| GPU 驱动 | 浮点精度/抗锯齿实现差异 | 更新驱动可能变 |
| 操作系统 | 字体渲染引擎（DirectWrite/FreeType） | 跨系统不同 |
| DPI 缩放 | 亚像素渲染策略 | 改缩放比例会变 |
| 浏览器版本 | Skia 渲染引擎更新 | 大版本升级可能变 |

因此**一台设备 + 一个浏览器版本 = 一组稳定指纹**。检测方据此理解：

- 同一真机重复访问，hash↔histogram 配对应保持稳定 → 通过绑定校验。
- 大量不同账号共享同一对真实值 → 命中关联分析（`PRINCIPLE.md` §7）。
- 随机 hash 配固定 histogram（或反之） → 命中绑定校验（`PRINCIPLE.md` §2）。

## 渲染流程概览

`renderCanvas()` 复现的步骤：

```
1. 矩形路径 rect(0,0,10,10) + rect(2,2,20,20)，isPointInPath(5,5,"evenodd") 探测
2. 橙色填充矩形 fillRect(95,1,62,30)
3. Arial 8pt/11pt 绘制 "Cwm fjordbank glyphs vext quiz,"
4. globalCompositeOperation="multiply" + 三个彩色圆（品红/青/黄）
5. "evenodd" 填充嵌套圆
6. 线性渐变 + 小圆
7. 不存在的字体 "dfgstg" 绘制 Math.tan/cos/sin(-1e300)
8. 二次贝塞尔曲线路径
9. globalCompositeOperation="difference" + 三个圆
最终: canvas_hash = CRC32(渲染输出)，histogram = 像素通道频率分布
```
