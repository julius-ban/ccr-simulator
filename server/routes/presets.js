const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, addLog } = require('../db');

const router = express.Router();

// 목록 조회 (이름/생성시각만 - 상세 데이터는 불러올 때만 내려줌 굳이 나눌 필요는 없지만 목록은 가볍게)
router.get('/', (req, res) => {
  const presets = db.get('presets').value() || [];
  res.json(presets);
});

// 저장 (새 프리셋 생성)
router.post('/', (req, res) => {
  const { name, data } = req.body;
  if (!name) return res.status(400).json({ error: 'name은 필수입니다.' });

  const preset = { id: uuidv4(), name, data: data || {}, createdAt: new Date().toISOString() };
  db.get('presets').push(preset).write();
  addLog({ action: 'save_preset', detail: { name } });
  res.status(201).json(preset);
});

// 삭제
router.delete('/:id', (req, res) => {
  db.get('presets').remove({ id: req.params.id }).write();
  addLog({ action: 'delete_preset', detail: { id: req.params.id } });
  res.json({ ok: true });
});

module.exports = router;
