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
  // 渲染序列与 canvas_reference.html 完全一致，保证采集器产出的基线
  // 与线上上报的 hash/histogram 可直接对接（见 CANVAS_COLLECTOR.md）。
  function canvasFingerprint() {
    const c = document.createElement('canvas');
    c.width = 150; c.height = 60;
    const t = c.getContext('2d');
    t.rect(0, 0, 10, 10);
    t.rect(2, 2, 20, 20);
    t.textBaseline = 'alphabetic';
    t.fillStyle = '#f60';
    t.fillRect(95, 1, 62, 30);
    t.fillStyle = '#069';
    t.font = '8pt Arial';
    t.fillText('Cwm fjordbank glyphs vext quiz,', 2, 15);
    t.fillStyle = 'rgba(102, 204, 0, 0.2)';
    t.font = '11pt Arial';
    t.fillText('Cwm fjordbank glyphs vext quiz,', 4, 45);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = 'rgb(255,0,255)';
    t.beginPath(); t.arc(30, 30, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(0,255,255)';
    t.beginPath(); t.arc(50, 30, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(255,255,0)';
    t.beginPath(); t.arc(35, 40, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(255,0,255)';
    t.arc(30, 25, 10, 0, 2 * Math.PI, true);
    t.arc(30, 25, 30, 0, 2 * Math.PI, true);
    t.fill('evenodd');
    const g = t.createLinearGradient(40, 50, 60, 62);
    g.addColorStop(0, 'blue');
    try { g.addColorStop(0.5, '78'); } catch (e) { g.addColorStop(0.5, '#808080'); }
    g.addColorStop(1, 'white');
    t.fillStyle = g;
    t.beginPath(); t.arc(70, 50, 10, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.font = '10pt dfgstg';
    t.strokeText(Math.tan(-1e300).toString(), 4, 30);
    t.fillText(Math.cos(-1e300).toString(), 4, 40);
    t.fillText(Math.sin(-1e300).toString(), 4, 50);
    t.beginPath();
    t.moveTo(25, 0);
    t.quadraticCurveTo(1, 1, 1, 5);
    t.quadraticCurveTo(1, 76, 26, 10);
    t.quadraticCurveTo(26, 96, 6, 12);
    t.quadraticCurveTo(60, 96, 41, 10);
    t.quadraticCurveTo(121, 86, 101, 7);
    t.quadraticCurveTo(121, 1, 56, 1);
    t.stroke();
    t.globalCompositeOperation = 'difference';
    t.fillStyle = 'rgb(255,0,255)';
    t.beginPath(); t.arc(80, 30, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(0,255,255)';
    t.beginPath(); t.arc(110, 30, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(255,255,0)';
    t.beginPath(); t.arc(95, 40, 30, 0, 2 * Math.PI, true); t.closePath(); t.fill();
    t.fillStyle = 'rgb(255,0,255)';

    // histogram: 渲染输出像素 RGBA 通道频率分布（256 桶，求和恒为 150×60×4）
    const data = t.getImageData(0, 0, c.width, c.height).data;
    const hist = new Array(256).fill(0);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    // canvas_hash = CRC32(isPointInPath 结果 + "~canvas fp:" + toDataURL())
    const tc = document.createElement('canvas').getContext('2d');
    tc.rect(0, 0, 10, 10); tc.rect(2, 2, 20, 20);
    const e = [0 == tc.isPointInPath(5, 5, 'evenodd') ? 'yes' : 'no',
               'canvas fp:' + c.toDataURL()];
    return { hash: crc32(e.join('~')) | 0, histogramBins: hist };
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
