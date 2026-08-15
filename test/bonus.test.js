/**
 * Ba thay đổi luật:
 *  - thứ tự chất: Bích < Tép < Cơ < Rô
 *  - úp bài lúc nào cũng được, kể cả khi không có gì phải theo
 *  - thưởng nhân: Sáp ăn gấp đôi, Liêng đồng chất ăn gấp rưỡi, do người thua trả
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { seededRandomInt, SUIT_STRENGTH } from '../src/engine/cards.js';
import { evaluateHand, compareHands } from '../src/engine/evaluate.js';
import {
  createGame, startRound, applyAction, getLegalActions, currentActor,
  flipCards, getPlayer, PHASE,
} from '../src/engine/game.js';

const RANKS = { A: 1, J: 11, Q: 12, K: 13 };
function c(str) {
  const suit = str.slice(-1);
  const r = str.slice(0, -1);
  return { rank: RANKS[r] ?? Number(r), suit };
}
const h = (...cards) => cards.map(c);

/* ================================================================== */
/*  THỨ TỰ CHẤT                                                        */
/* ================================================================== */

test('thứ tự chất từ thấp tới cao: Bích < Tép < Cơ < Rô', () => {
  assert.ok(SUIT_STRENGTH['♠'] < SUIT_STRENGTH['♣'], 'Bích < Tép');
  assert.ok(SUIT_STRENGTH['♣'] < SUIT_STRENGTH['♥'], 'Tép < Cơ');
  assert.ok(SUIT_STRENGTH['♥'] < SUIT_STRENGTH['♦'], 'Cơ < Rô');
});

test('hoà điểm hoà lá: Rô thắng Cơ (trước đây ngược lại)', () => {
  const ro = evaluateHand(h('K♦', '9♠', '10♣'));
  const co = evaluateHand(h('K♥', '9♠', '10♣'));
  assert.ok(compareHands(ro, co) > 0, 'K Rô phải thắng K Cơ');
});

test('Rô > Cơ > Tép > Bích khi cùng lá', () => {
  const bo = (suit) => evaluateHand(h(`K${suit}`, '9♠', '10♣'));
  const xep = ['♠', '♣', '♥', '♦'].map(bo);
  for (let i = 1; i < xep.length; i++) {
    assert.ok(compareHands(xep[i], xep[i - 1]) > 0, `chất thứ ${i} phải mạnh hơn chất trước`);
  }
});

/* ================================================================== */
/*  ÚP BÀI LÚC NÀO CŨNG ĐƯỢC                                           */
/* ================================================================== */

function banVoiBot(seed = 1, n = 3, config = {}) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ id: `p${i}`, name: `P${i}`, isBot: i > 0 });
  return createGame({ players, config, randomInt: seededRandomInt(seed) });
}

test('xem bài xấu ngay vòng đầu là úp được, dù chưa ai tố', () => {
  const game = banVoiBot(7);
  startRound(game);

  // Cho bot đi hết để tới lượt người thật
  let guard = 0;
  while (game.phase === PHASE.BETTING && currentActor(game)?.isBot && guard++ < 20) {
    const legal = getLegalActions(game);
    applyAction(game, legal.playerId, { type: 'call', actionSeq: legal.actionSeq });
  }
  const actor = currentActor(game);
  assert.equal(actor.id, 'p0');

  flipCards(game, 'p0', 'all');
  const legal = getLegalActions(game);
  assert.equal(legal.callAmount, 0, 'chưa ai tố nên không có gì phải theo');
  assert.equal(legal.canFold, true, 'vẫn phải úp được');

  const res = applyAction(game, 'p0', { type: 'fold', actionSeq: legal.actionSeq });
  assert.ok(res.ok);
  assert.equal(getPlayer(game, 'p0').folded, true, 'phải úp được thật, không bị đổi thành giữ bài');
});

test('úp xong thì không bị hỏi lượt nữa, ván chạy tiếp tới hết', () => {
  const game = banVoiBot(11, 4);
  startRound(game);

  let guard = 0;
  while (game.phase === PHASE.BETTING && currentActor(game)?.isBot && guard++ < 20) {
    const legal = getLegalActions(game);
    applyAction(game, legal.playerId, { type: 'call', actionSeq: legal.actionSeq });
  }
  const legal = getLegalActions(game);
  applyAction(game, legal.playerId, { type: 'fold', actionSeq: legal.actionSeq });
  const daUp = legal.playerId;

  // Chạy nốt ván bằng bot
  guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 60) {
    const l = getLegalActions(game);
    assert.notEqual(l.playerId, daUp, 'người đã úp không được hỏi lượt nữa');
    applyAction(game, l.playerId, { type: 'call', actionSeq: l.actionSeq });
  }
  assert.notEqual(game.phase, PHASE.BETTING, 'ván phải kết thúc, không treo');
});

/* ================================================================== */
/*  THƯỞNG NHÂN                                                        */
/* ================================================================== */

test('evaluateHand gắn hệ số nhân đúng', () => {
  assert.equal(evaluateHand(h('7♠', '7♥', '7♦')).multiplier, 2, 'Sáp ăn đôi');
  assert.equal(evaluateHand(h('5♦', '6♦', '7♦')).multiplier, 1.5, 'Liêng đồng chất ăn gấp rưỡi');
  assert.equal(evaluateHand(h('5♦', '6♥', '7♠')).multiplier, 1, 'Liêng khác chất thì thường');
  assert.equal(evaluateHand(h('K♦', '9♦', '2♦')).multiplier, 1, 'Điểm đồng chất không được thưởng');
  assert.equal(evaluateHand(h('J♦', 'Q♦', 'K♦')).multiplier, 1, 'Ảnh đồng chất không được thưởng');
});

test('Liêng đồng chất có ghi rõ trong tên bài', () => {
  assert.match(evaluateHand(h('5♦', '6♦', '7♦')).label, /đồng chất/);
  assert.ok(!evaluateHand(h('5♦', '6♥', '7♠')).label.includes('đồng chất'));
});

/** Dựng một ván ngửa bài với bài chỉ định sẵn, ai cũng theo tới cùng. */
function vanNguaBai({ baiThang, baiThua, chips = 100_000, ante = 1_000 }) {
  const game = createGame({
    players: [
      { id: 'thang', name: 'Thắng', chips },
      { id: 'thua1', name: 'Thua 1', chips },
      { id: 'thua2', name: 'Thua 2', chips },
    ],
    config: { ante, maxRaises: 2 },
    randomInt: seededRandomInt(3),
  });
  startRound(game);
  // Đặt bài theo ý muốn
  getPlayer(game, 'thang').hand = baiThang;
  getPlayer(game, 'thua1').hand = baiThua[0];
  getPlayer(game, 'thua2').hand = baiThua[1];
  for (const id of ['thang', 'thua1', 'thua2']) flipCards(game, id, 'all');

  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 40) {
    const l = getLegalActions(game);
    applyAction(game, l.playerId, { type: 'call', actionSeq: l.actionSeq });
  }
  return game;
}

const tongChip = (game) => game.players.reduce((s, p) => s + p.chips, 0) + game.pot;

test('thắng bằng Sáp: mỗi người thua trả thêm đúng phần mình đã bỏ vào hũ', () => {
  const game = vanNguaBai({
    baiThang: h('7♠', '7♥', '7♦'),          // Sáp, hệ số 2
    baiThua: [h('2♠', '3♥', '9♦'), h('4♠', '5♥', 'K♦')],
    ante: 1_000,
  });

  const r = game.lastResult;
  assert.ok(r.bonus, 'phải có thưởng nhân');
  assert.equal(r.bonus.multiplier, 2);
  assert.equal(r.bonus.playerId, 'thang');

  // Mỗi người thua bỏ 1.000 vào hũ, phải trả thêm đúng 1.000
  assert.equal(r.bonus.tra.thua1, 1_000);
  assert.equal(r.bonus.tra.thua2, 1_000);
  assert.equal(r.bonus.total, 2_000);

  assert.equal(getPlayer(game, 'thang').chips, 100_000 + 2_000 + 2_000, 'ăn hũ 3.000 (lãi 2.000) + thưởng 2.000');
  assert.equal(getPlayer(game, 'thua1').chips, 100_000 - 2_000);
  assert.equal(getPlayer(game, 'thua2').chips, 100_000 - 2_000);
});

test('thắng bằng Liêng đồng chất: người thua trả thêm một nửa', () => {
  const game = vanNguaBai({
    baiThang: h('5♦', '6♦', '7♦'),          // Liêng đồng chất, hệ số 1.5
    baiThua: [h('2♠', '3♥', '9♦'), h('4♠', '5♥', 'K♦')],
    ante: 1_000,
  });
  const r = game.lastResult;
  assert.equal(r.bonus.multiplier, 1.5);
  assert.equal(r.bonus.tra.thua1, 500, 'trả thêm một nửa số đã bỏ vào');
  assert.equal(r.bonus.total, 1_000);
});

test('Liêng KHÁC chất thì không có thưởng nhân', () => {
  const game = vanNguaBai({
    baiThang: h('5♦', '6♥', '7♠'),
    baiThua: [h('2♠', '3♥', '9♦'), h('4♠', '5♥', 'K♦')],
  });
  assert.equal(game.lastResult.bonus, null);
});

test('thưởng nhân KHÔNG tạo ra xu từ hư không', () => {
  for (const bai of [h('7♠', '7♥', '7♦'), h('5♦', '6♦', '7♦')]) {
    const game = createGame({
      players: [
        { id: 'thang', name: 'T', chips: 100_000 },
        { id: 'thua1', name: 'A', chips: 100_000 },
        { id: 'thua2', name: 'B', chips: 100_000 },
      ],
      config: { ante: 1_000, maxRaises: 2 },
      randomInt: seededRandomInt(5),
    });
    const vonBanDau = tongChip(game);
    startRound(game);
    getPlayer(game, 'thang').hand = bai;
    getPlayer(game, 'thua1').hand = h('2♠', '3♥', '9♦');
    getPlayer(game, 'thua2').hand = h('4♠', '5♥', 'K♦');
    for (const id of ['thang', 'thua1', 'thua2']) flipCards(game, id, 'all');
    let guard = 0;
    while (game.phase === PHASE.BETTING && guard++ < 40) {
      const l = getLegalActions(game);
      applyAction(game, l.playerId, { type: 'call', actionSeq: l.actionSeq });
    }
    assert.equal(tongChip(game), vonBanDau, 'tổng chip cả bàn phải không đổi');
  }
});

test('người thua không đủ chip thì chỉ trả tới mức còn lại, không âm', () => {
  const game = createGame({
    players: [
      { id: 'thang', name: 'T', chips: 100_000 },
      { id: 'ngheo', name: 'Nghèo', chips: 1_000 }, // vừa đủ tiền sàn, tất tay ngay
      { id: 'thua2', name: 'B', chips: 100_000 },
    ],
    config: { ante: 1_000, maxRaises: 2 },
    randomInt: seededRandomInt(9),
  });
  const vonBanDau = tongChip(game);
  startRound(game);
  getPlayer(game, 'thang').hand = h('7♠', '7♥', '7♦');
  getPlayer(game, 'ngheo').hand = h('2♠', '3♥', '9♦');
  getPlayer(game, 'thua2').hand = h('4♠', '5♥', 'K♦');
  for (const id of ['thang', 'ngheo', 'thua2']) flipCards(game, id, 'all');
  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 40) {
    const l = getLegalActions(game);
    applyAction(game, l.playerId, { type: 'call', actionSeq: l.actionSeq });
  }

  for (const p of game.players) assert.ok(p.chips >= 0, `${p.id} bị âm chip: ${p.chips}`);
  assert.equal(tongChip(game), vonBanDau, 'vẫn không được sinh xu');
});

test('mọi người úp hết thì KHÔNG có thưởng nhân', () => {
  const game = createGame({
    players: [
      { id: 'thang', name: 'T', chips: 100_000 },
      { id: 'thua1', name: 'A', chips: 100_000 },
    ],
    config: { ante: 1_000, maxRaises: 2 },
    randomInt: seededRandomInt(13),
  });
  const vonBanDau = tongChip(game);
  startRound(game);
  getPlayer(game, 'thang').hand = h('7♠', '7♥', '7♦'); // Sáp

  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 20) {
    const l = getLegalActions(game);
    // Ai không phải người cầm Sáp thì úp bài
    if (l.playerId !== 'thang') {
      applyAction(game, l.playerId, { type: 'fold', actionSeq: l.actionSeq });
    } else {
      flipCards(game, 'thang', 'all');
      applyAction(game, 'thang', { type: 'call', actionSeq: getLegalActions(game).actionSeq });
    }
  }

  assert.equal(game.lastResult.bonus, null, 'không ngửa bài thì không tính thưởng');
  assert.equal(tongChip(game), vonBanDau);
});
