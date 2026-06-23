/**
 * 评分引擎自测 — 纯逻辑，不依赖 express，可直接 `node test.js` 运行
 * 用合成 payload 覆盖各校验维度，断言风险分级符合预期。
 */
'use strict';
const assert = require('assert');
const { Validator, EXPECTED_HISTOGRAM_SUM } = require('./validate');

const now = Date.now();

// 构造一个结构合法的 histogram: 256 桶，求和 = 36000
function validHistogram() {
  const bins = new Array(256).fill(0);
  bins[0] = EXPECTED_HISTOGRAM_SUM;
  return bins;
}

// 一个"干净"的真人浏览器 payload 基线
function cleanPayload(over = {}) {
  return {
    version: '1.0.0', eventType: 'PageLoad',
    start: now - 200, end: now,
    timeToSubmit: 0,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0 Safari/537.36',
    timeZone: 8, webDriver: false,
    automation: { webdriver: false, phantom: false, cdp: false, headlessUA: false },
    performance: { timing: {
      navigationStart: now - 4000, fetchStart: now - 3990,
      domainLookupStart: now - 3985, connectStart: now - 3980,
      responseStart: now - 3500, domInteractive: now - 800, loadEventEnd: now - 300,
    }},
    interaction: { clicks: 0, keyPresses: 0, keyPressTimeIntervals: [], mouseClickPositions: [] },
    canvas: { hash: 123456789, histogramBins: validHistogram() },
    gpu: { vendor: 'Intel', model: 'Intel Iris Xe', extensions: ['EXT_blend_minmax', 'OES_texture_float'] },
    math: { tan: -1.2, sin: 0.5, cos: 0.8 },
    screenInfo: '1920-1080-1040-24-*-*-*',
    plugins: ['PDF Viewer', 'Chrome PDF Viewer'],
    ...over,
  };
}

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
}

// ── 1. 干净 payload → low ──
{
  const v = new Validator();
  const r = v.evaluate(cleanPayload(), { sessionKey: 's1', accountId: 'a1' });
  check('干净浏览器判定为 low', r.riskLevel === 'low' && r.score === 0);
}

// ── 2. 自动化痕迹 → high ──
{
  const v = new Validator();
  const r = v.evaluate(cleanPayload({
    webDriver: true,
    automation: { webdriver: true, phantom: true, cdp: true, headlessUA: true },
    gpu: { vendor: 'Google', model: 'Google SwiftShader', extensions: [] },
  }), { sessionKey: 's2', accountId: 'a2' });
  check('自动化工具命中多项痕迹', r.reasons.some(x => x.category === 'automation'));
  check('自动化痕迹累计为 high', r.riskLevel === 'high');
}

// ── 3. 结构校验: histogram 桶数错误 ──
{
  const v = new Validator();
  const r = v.evaluate(cleanPayload({ canvas: { hash: 111, histogramBins: [1, 2, 3] } }),
    { sessionKey: 's3' });
  check('histogram 桶数异常被捕获', r.reasons.some(x => x.category === 'structure'));
}

// ── 4. 绑定一致性: 同一 hash 携带不同 histogram ──
{
  const v = new Validator();
  v.evaluate(cleanPayload(), { sessionKey: 's4a' }); // 首次注册 hash=123456789
  const tampered = validHistogram();
  tampered[0] = EXPECTED_HISTOGRAM_SUM - 100; tampered[1] = 100; // 改变分布但保持求和
  const r = v.evaluate(cleanPayload({ canvas: { hash: 123456789, histogramBins: tampered } }),
    { sessionKey: 's4b' });
  check('同一 hash 绑定不同 histogram 被捕获', r.reasons.some(x => x.category === 'binding'));
}

// ── 5. 行为合理性: PageLoad 却有交互 ──
{
  const v = new Validator();
  const r = v.evaluate(cleanPayload({
    eventType: 'PageLoad',
    interaction: { clicks: 3, keyPresses: 5, keyPressTimeIntervals: [100, 100], mouseClickPositions: [] },
  }), { sessionKey: 's5' });
  check('PageLoad 携带交互被捕获', r.reasons.some(x => x.category === 'behavior'));
}

// ── 6. 时序: start > end ──
{
  const v = new Validator();
  const r = v.evaluate(cleanPayload({ start: now, end: now - 1000 }), { sessionKey: 's6' });
  check('start>end 时序矛盾被捕获', r.reasons.some(x => x.category === 'timing'));
}

// ── 7. 会话稳定性: 硬件字段突变 ──
{
  const v = new Validator();
  v.evaluate(cleanPayload(), { sessionKey: 'sess-X' });
  const r = v.evaluate(cleanPayload({ canvas: { hash: 999, histogramBins: validHistogram() } }),
    { sessionKey: 'sess-X' });
  check('会话内 canvas hash 突变被捕获', r.reasons.some(x => x.category === 'sessionDrift'));
}

// ── 8. 关联分析: 同一指纹横跨多账号 ──
{
  const v = new Validator();
  let last;
  for (let i = 0; i < 8; i++)
    last = v.evaluate(cleanPayload(), { sessionKey: `corr-${i}`, accountId: `acct-${i}` });
  check('同一指纹关联超阈值账号被捕获', last.reasons.some(x => x.category === 'correlation'));
}

console.log(`\n全部 ${passed} 项断言通过 ✓`);
