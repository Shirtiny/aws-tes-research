/**
 * TES 指纹检测 — 核心评分引擎（纯计算，可移植到任意后端）
 *
 * 用法:
 *   const v = new Validator();
 *   const result = v.evaluate(payload, { sessionKey, accountId });
 *   // result = { score, riskLevel, reasons }
 *
 * 注册表用内存 Map 演示，生产环境替换为 Redis/数据库。
 */

'use strict';

// 固定尺寸 canvas (150×60) 的像素采样数: 150*60*4 个通道值
const EXPECTED_HISTOGRAM_BINS = 256;
const EXPECTED_HISTOGRAM_SUM = 150 * 60 * 4; // = 36000
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const CLOCK_SKEW_MS = 5 * 60 * 1000;         // 容忍 ±5 分钟时钟漂移
const CORRELATION_THRESHOLD = 5;             // 同一指纹关联账号数告警阈值

// performance.timing 必须满足的先后顺序
const TIMING_ORDER = [
  'navigationStart', 'fetchStart', 'domainLookupStart',
  'connectStart', 'responseStart', 'domInteractive', 'loadEventEnd',
];

const WEIGHTS = {
  structure: 40, binding: 50, sessionDrift: 30,
  automation: 15, behavior: 20, timing: 25,
};

function histogramDigest(bins) {
  // 摘要必须对「分布」敏感: 仅靠求和无法区分同总量、不同形状的伪造数据。
  // 用 FNV-1a 对整个桶序列做哈希，任意桶变动都会改变 dist。
  let sum = 0, dist = 0x811c9dc5;
  for (let i = 0; i < bins.length; i++) {
    sum += bins[i];
    dist ^= bins[i] & 0xff;
    dist = Math.imul(dist, 0x01000193);
    dist ^= (bins[i] >>> 8) & 0xff;
    dist = Math.imul(dist, 0x01000193);
  }
  return { len: bins.length, sum, dist: dist >>> 0 };
}

// ── ① 结构校验 ──
function checkStructure(p, hit) {
  const c = p.canvas || {};
  const bins = c.histogramBins;
  if (!Array.isArray(bins) || bins.length !== EXPECTED_HISTOGRAM_BINS) {
    hit('structure', `histogram 桶数异常: ${Array.isArray(bins) ? bins.length : 'N/A'} != 256`);
    return;
  }
  const sum = bins.reduce((a, b) => a + b, 0);
  if (sum !== EXPECTED_HISTOGRAM_SUM) {
    hit('structure', `histogram 求和不变量破坏: ${sum} != ${EXPECTED_HISTOGRAM_SUM}`);
  }
  if (!Number.isInteger(c.hash) || c.hash < INT32_MIN || c.hash > INT32_MAX) {
    hit('structure', `canvas hash 非 int32: ${c.hash}`);
  }
  const now = Date.now();
  for (const f of ['start', 'end']) {
    if (typeof p[f] !== 'number' || Math.abs(now - p[f]) > CLOCK_SKEW_MS) {
      hit('structure', `时间戳 ${f} 偏离服务器时间过大`);
    }
  }
}

// ── ② 绑定一致性: 同一 canvas hash 必须携带同一 histogram ──
function checkBinding(p, registry, hit) {
  const c = p.canvas || {};
  if (!Array.isArray(c.histogramBins) || !Number.isInteger(c.hash)) return;
  const digest = histogramDigest(c.histogramBins);
  const known = registry.get(c.hash);
  if (!known) {
    registry.set(c.hash, digest);
  } else if (known.len !== digest.len || known.sum !== digest.sum || known.dist !== digest.dist) {
    hit('binding', `canvas hash ${c.hash} 绑定了不一致的 histogram（疑似伪造设备）`);
  }
}

// ── ④ 自动化痕迹 ──
function checkAutomation(p, hit) {
  const a = p.automation || {};
  if (p.webDriver || a.webdriver) hit('automation', 'navigator.webdriver = true');
  if (a.phantom) hit('automation', '检测到无头框架注入痕迹');
  if (a.cdp) hit('automation', '检测到 CDP 残留变量');
  if (a.headlessUA) hit('automation', 'UA 含 Headless 标记');
  const gpu = (p.gpu && p.gpu.model || '').toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(gpu)) hit('automation', `软件渲染 GPU: ${p.gpu.model}`);
  if (Array.isArray(p.plugins) && p.plugins.length === 0 && /windows|macintosh/i.test(p.userAgent || ''))
    hit('automation', '桌面 UA 但插件列表为空');
  if (p.gpu && Array.isArray(p.gpu.extensions) && p.gpu.extensions.length === 0)
    hit('automation', 'WebGL 扩展列表为空');
}
// ── ⑤ 行为合理性 ──
function checkBehavior(p, hit) {
  const i = p.interaction || {};
  if (p.eventType === 'PageLoad') {
    if ((i.clicks || 0) > 0 || (i.keyPresses || 0) > 0)
      hit('behavior', 'PageLoad 事件却携带用户交互（疑似脚本伪造）');
    return;
  }
  const intervals = i.keyPressTimeIntervals || [];
  const keys = i.keyPresses || 0;
  if (keys > 0 && intervals.length >= keys)
    hit('behavior', `交互数量矛盾: intervals(${intervals.length}) >= keyPresses(${keys})`);
  if (intervals.length >= 3) {
    const uniq = new Set(intervals).size;
    if (uniq === 1) hit('behavior', '按键间隔完全相等（机器输入节奏）');
    if (intervals.some(v => v === 0)) hit('behavior', '存在 0ms 按键间隔（非人类）');
  }
  if (p.timeToSubmit > 0 && p.timeToSubmit < 300 && keys >= 6)
    hit('behavior', `${p.timeToSubmit}ms 内完成 ${keys} 次输入（过快）`);
}

// ── ⑥ 时序连贯性 ──
function checkTiming(p, hit) {
  if (typeof p.start === 'number' && typeof p.end === 'number') {
    if (p.start > p.end) hit('timing', `start > end（${p.start} > ${p.end}）`);
  }
  const t = (p.performance && p.performance.timing) || {};
  let prev = -Infinity, prevName = '';
  for (const name of TIMING_ORDER) {
    const v = t[name];
    if (typeof v !== 'number' || v === 0) continue;
    if (v < prev) { hit('timing', `performance.timing 顺序矛盾: ${name} < ${prevName}`); break; }
    prev = v; prevName = name;
  }
  if (typeof t.loadEventEnd === 'number' && t.loadEventEnd > 0 &&
      typeof p.start === 'number' && t.loadEventEnd > p.start)
    hit('timing', 'loadEventEnd 晚于指纹采集 start（页面未加载完即采集）');
}

// ── ③ 会话稳定性: 硬件/环境字段在会话内不得突变 ──
function checkSessionDrift(p, prevSnapshot, hit) {
  if (!prevSnapshot) return;
  const cur = sessionSnapshot(p);
  for (const k of Object.keys(cur)) {
    if (prevSnapshot[k] !== undefined && prevSnapshot[k] !== cur[k])
      hit('sessionDrift', `会话内 ${k} 发生突变（硬件字段不应改变）`);
  }
}

function sessionSnapshot(p) {
  // 仅纳入跨页面/刷新都应恒定的硬件字段。
  // 注意: performance.timing.navigationStart 每次整页加载都会变，
  // 不能放进会话快照，否则同一用户刷新页面会被误判为突变。
  const c = p.canvas || {}, g = p.gpu || {};
  return {
    canvasHash: c.hash,
    gpuModel: g.model,
    screenInfo: p.screenInfo,
  };
}

// ── ⑦ 关联分析: 同一指纹横跨过多账号 ──
function checkCorrelation(p, correlation, accountId, hit) {
  if (!accountId || !p.canvas || !Number.isInteger(p.canvas.hash)) return;
  let set = correlation.get(p.canvas.hash);
  if (!set) { set = new Set(); correlation.set(p.canvas.hash, set); }
  set.add(accountId);
  if (set.size > CORRELATION_THRESHOLD) {
    // 非线性增长: 超阈值越多，加分越重
    const over = set.size - CORRELATION_THRESHOLD;
    hit('correlation', `canvas hash 已关联 ${set.size} 个账号（疑似批量农场）`, 10 + over * over);
  }
}

class Validator {
  constructor() {
    this.bindingRegistry = new Map();   // canvas hash -> histogram 摘要
    this.sessions = new Map();          // sessionKey -> 硬件快照
    this.correlation = new Map();       // canvas hash -> Set<accountId>
  }

  evaluate(payload, { sessionKey, accountId } = {}) {
    const reasons = [];
    let score = 0;
    const hit = (category, msg, customWeight) => {
      const w = customWeight != null ? customWeight : (WEIGHTS[category] || 10);
      score += w;
      reasons.push({ category, msg, weight: w });
    };

    checkStructure(payload, hit);
    checkBinding(payload, this.bindingRegistry, hit);
    checkAutomation(payload, hit);
    checkBehavior(payload, hit);
    checkTiming(payload, hit);

    if (sessionKey) {
      checkSessionDrift(payload, this.sessions.get(sessionKey), hit);
      this.sessions.set(sessionKey, sessionSnapshot(payload));
    }
    checkCorrelation(payload, this.correlation, accountId, hit);

    score = Math.min(100, score);
    const riskLevel = score >= 70 ? 'high' : score >= 30 ? 'mid' : 'low';
    return { score, riskLevel, reasons };
  }
}

module.exports = {
  Validator,
  // 导出纯函数，便于在其它语言/框架中单独复用或测试
  checkStructure, checkBinding, checkAutomation,
  checkBehavior, checkTiming, sessionSnapshot,
  EXPECTED_HISTOGRAM_SUM, EXPECTED_HISTOGRAM_BINS,
};
