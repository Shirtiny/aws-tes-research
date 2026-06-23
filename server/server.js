/**
 * TES 指纹检测 — Express demo 服务
 *   GET  /          -> demo.html
 *   GET  /fingerprint.js -> 客户端采集器
 *   POST /collect   -> 接收指纹上报，返回风险评估
 */
'use strict';
const express = require('express');
const path = require('path');
const { Validator } = require('./validate');

const app = express();
app.use(express.json({ limit: '256kb' }));

const validator = new Validator();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/demo.html')));
app.get('/fingerprint.js', (req, res) => res.sendFile(path.join(__dirname, '../client/fingerprint.js')));

app.post('/collect', (req, res) => {
  const payload = req.body || {};
  // sessionKey: 演示用 cookie/IP；生产环境用真实会话标识
  // accountId: 演示用上报里的 account 字段；生产环境用登录用户 ID
  const sessionKey = req.headers['x-session'] || req.ip;
  const accountId = payload.accountId || null;
  const result = validator.evaluate(payload, { sessionKey, accountId });
  console.log(`[collect] event=${payload.eventType} risk=${result.riskLevel}(${result.score}) reasons=${result.reasons.length}`);
  res.json(result);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`TES 检测 demo: http://localhost:${PORT}/`));
