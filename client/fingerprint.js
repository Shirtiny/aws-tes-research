/**
 * TES 指纹采集器 — 浏览器端，无依赖
 * 用法: const fp = TESFingerprint.collect('PageLoad' | 'Submit')
 *       随业务请求把 fp 上报给服务端 /collect
 */
(function (global) {
  'use strict';

  // ── 行为层: 全局监听用户交互，累计计数（行为字段每次采集都不同）──
  const behavior = {
    clicks: 0, keyPresses: 0,
    keyPressTimeIntervals: [], mouseClickPositions: [],
    _lastKeyTs: 0, _pageStart: Date.now(),
  };
  addEventListener('click', (e) => {
    behavior.clicks++;
    behavior.mouseClickPositions.push(`${e.clientX},${e.clientY}`);
  }, true);
  addEventListener('keydown', () => {
    const now = performance.now();
    if (behavior._lastKeyTs) {
      const dt = Math.round(now - behavior._lastKeyTs);
      if (dt > 0) behavior.keyPressTimeIntervals.push(dt);
    }
    behavior._lastKeyTs = now;
    behavior.keyPresses++;
  }, true);

  // ── CRC32 (canvas hash 用) ──
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(str) {
    let crc = -1;
    for (let i = 0; i < str.length; i++)
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF];
    return crc ^ -1;
  }

  // ── 硬件层: canvas hash + histogram，由同一次渲染派生（确定性绑定）──
  function canvasFingerprint() {
    const c = document.createElement('canvas');
    c.width = 150; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '11pt Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(95, 1, 62, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('Cwm fjordbank glyphs vext quiz,', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('Cwm fjordbank glyphs vext quiz,', 4, 17);
    ctx.globalCompositeOperation = 'multiply';
    [['#f0f', 40, 40], ['#0ff', 80, 40], ['#ff0', 60, 80]].forEach(([color, x, y]) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 40, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.fill();
    });
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    return { hash: crc32(c.toDataURL()) | 0, histogramBins: hist };
  }

  function gpuInfo() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return { vendor: '', model: '', extensions: [] };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '',
        model: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '',
        extensions: gl.getSupportedExtensions() || [],
      };
    } catch (e) { return { vendor: '', model: '', extensions: [] }; }
  }

  function automationSignals() {
    return {
      webdriver: navigator.webdriver === true,
      phantom: !!(window.phantom || window._phantom || window.__nightmare),
      cdp: !!(window.cdc_adoQpoasnfa76pfcZLmcfl_Array ||
              document.$cdc_asdjflasutopfhvcZLmcfl_),
      headlessUA: /headless/i.test(navigator.userAgent),
    };
  }

  function perfTiming() {
    const t = performance.timing || {};
    return {
      navigationStart: t.navigationStart, fetchStart: t.fetchStart,
      domainLookupStart: t.domainLookupStart, connectStart: t.connectStart,
      responseStart: t.responseStart, domInteractive: t.domInteractive,
      loadEventEnd: t.loadEventEnd,
    };
  }

  let _hwCache = null;  // 硬件层会话内只采集一次，保证恒定
  function collect(eventType = 'PageLoad') {
    const start = Date.now();
    if (!_hwCache) _hwCache = {
      canvas: canvasFingerprint(),
      gpu: gpuInfo(),
      math: { tan: Math.tan(-1e300), sin: Math.sin(-1e300), cos: Math.cos(-1e300) },
      screenInfo: `${screen.width}-${screen.height}-${screen.availHeight}-${screen.colorDepth}-*-*-*`,
      plugins: Array.from(navigator.plugins || []).map(p => p.name),
    };
    const interaction = eventType === 'PageLoad'
      ? { clicks: 0, keyPresses: 0, keyPressTimeIntervals: [], mouseClickPositions: [] }
      : {
          clicks: behavior.clicks, keyPresses: behavior.keyPresses,
          keyPressTimeIntervals: behavior.keyPressTimeIntervals.slice(),
          mouseClickPositions: behavior.mouseClickPositions.slice(),
        };
    return {
      version: '1.0.0', eventType, start, end: Date.now(),
      timeToSubmit: eventType === 'PageLoad' ? 0 : Date.now() - behavior._pageStart,
      userAgent: navigator.userAgent,
      timeZone: -new Date().getTimezoneOffset() / 60,
      webDriver: navigator.webdriver === true,
      automation: automationSignals(),
      performance: { timing: perfTiming() },
      interaction,
      ..._hwCache,
    };
  }

  global.TESFingerprint = { collect };
})(window);
