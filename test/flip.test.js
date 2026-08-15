/**
 * Lật bài: cả 3 lá được chia úp, người chơi tự mở từng lá.
 *
 * Điều quan trọng nhất cần kiểm tra: lá chưa lật KHÔNG được gửi xuống client.
 * Nếu chỉ che bằng CSS thì mở DevTools là xem trước được hết.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { seededRandomInt } from '../src/engine/cards.js';
import {
  createGame,
  startRound,
  applyAction,
  getLegalActions,
  currentActor,
  publicView,
  timeoutAction,
  flipCards,
  allRevealed,
  revealedCount,
  getPlayer,
  PHASE,
} from '../src/engine/game.js';

function newGame(seed = 1, n = 3) {
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({ id: `p${i}`, name: `P${i}`, isBot: i > 0 });
  }
  return createGame({ players, randomInt: seededRandomInt(seed) });
}

/** Đưa lượt về người thật p0 (bot đi trước thì cho chúng đi hết). */
function chayToiLuotNguoiThat(game) {
  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 30) {
    const actor = currentActor(game);
    if (!actor || !actor.isBot) return actor;
    const legal = getLegalActions(game);
    applyAction(game, actor.id, { type: 'call', actionSeq: legal.actionSeq });
  }
  return currentActor(game);
}

/* ================================================================== */

test('chia bài xong: cả 3 lá của người thật đều úp, bot thì tự thấy bài', () => {
  const game = newGame(5);
  startRound(game);

  const me = getPlayer(game, 'p0');
  assert.deepEqual(me.revealed, [false, false, false]);
  assert.equal(allRevealed(me), false);

  for (const bot of game.players.filter((p) => p.isBot)) {
    assert.equal(allRevealed(bot), true, 'bot phải tự nhìn được bài của nó');
  }
});

test('CHỐNG XEM TRƯỚC: lá chưa lật không nằm trong gói tin gửi cho chính chủ', () => {
  const game = newGame(9);
  startRound(game);
  const me = getPlayer(game, 'p0');

  let view = publicView(game, 'p0');
  let mine = view.players.find((p) => p.id === 'p0');
  assert.deepEqual(mine.cards, [null, null, null], 'chưa lật thì không được gửi lá nào');
  assert.equal(mine.cardCount, 3, 'nhưng vẫn biết mình cầm 3 lá');
  assert.equal(mine.revealedCount, 0);

  // Kiểm tra thô trên chuỗi JSON thật sự đi qua đường mạng
  const raw = JSON.stringify(view);
  for (const card of me.hand) {
    assert.ok(
      !raw.includes(`"rank":${card.rank},"suit":"${card.suit}"`),
      `lá ${card.rank}${card.suit} bị lộ khi chưa lật`,
    );
  }

  // Lật lá giữa
  flipCards(game, 'p0', 1);
  view = publicView(game, 'p0');
  mine = view.players.find((p) => p.id === 'p0');
  assert.equal(mine.cards[0], null);
  assert.deepEqual(mine.cards[1], me.hand[1], 'lá vừa lật phải hiện ra');
  assert.equal(mine.cards[2], null);
  assert.equal(mine.revealedCount, 1);
});

test('lật từng lá một, lật đủ 3 lần thì xong', () => {
  const game = newGame(11);
  startRound(game);

  for (let i = 0; i < 3; i++) {
    const res = flipCards(game, 'p0', i);
    assert.ok(res.ok);
    assert.equal(res.events[0].type, 'flip');
    assert.deepEqual(res.events[0].indexes, [i]);
    assert.equal(res.events[0].revealedCount, i + 1);
  }
  assert.equal(allRevealed(getPlayer(game, 'p0')), true);
});

test('lật lại lá đã lật thì báo lỗi, không sinh sự kiện thừa', () => {
  const game = newGame(13);
  startRound(game);
  assert.ok(flipCards(game, 'p0', 0).ok);
  const lai = flipCards(game, 'p0', 0);
  assert.equal(lai.ok, false);
  assert.match(lai.error, /đã lật rồi/);
  assert.equal(lai.events.length, 0);
});

test('"mở hết" lật cả 3 lá trong một lần', () => {
  const game = newGame(17);
  startRound(game);
  const res = flipCards(game, 'p0', 'all');
  assert.ok(res.ok);
  assert.deepEqual(res.events[0].indexes, [0, 1, 2]);
  assert.equal(revealedCount(getPlayer(game, 'p0')), 3);
});

test('"mở hết" khi đã lật sẵn một lá thì chỉ lật hai lá còn lại', () => {
  const game = newGame(19);
  startRound(game);
  flipCards(game, 'p0', 2);
  const res = flipCards(game, 'p0', 'all');
  assert.deepEqual(res.events[0].indexes, [0, 1], 'không lật lại lá đã mở');
});

test('chỉ số lá không hợp lệ bị từ chối', () => {
  const game = newGame(23);
  startRound(game);
  for (const xau of [-1, 3, 99, 'một', null]) {
    assert.equal(flipCards(game, 'p0', xau).ok, false, `chỉ số ${xau} phải bị chặn`);
  }
  assert.equal(revealedCount(getPlayer(game, 'p0')), 0);
});

/* ================================================================== */
/*  CHƯA MỞ BÀI THÌ KHÔNG ĐƯỢC ĐẶT CƯỢC                                */
/* ================================================================== */

test('chưa mở hết bài thì không Theo, không Tố được', () => {
  const game = newGame(29);
  startRound(game);
  const actor = chayToiLuotNguoiThat(game);
  assert.equal(actor.id, 'p0');

  const legal = getLegalActions(game);
  assert.equal(legal.allRevealed, false);
  assert.equal(legal.canCall, false);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.revealedCount, 0);

  const theo = applyAction(game, 'p0', { type: 'call', actionSeq: legal.actionSeq });
  assert.equal(theo.ok, false);
  assert.match(theo.error, /mở hết 3 lá/);

  const to = applyAction(game, 'p0', { type: 'raise', amount: 999, actionSeq: legal.actionSeq });
  assert.equal(to.ok, false);
  assert.match(to.error, /mở hết 3 lá/);

  // Không có đồng nào bị trừ
  assert.equal(getPlayer(game, 'p0').betThisRound, game.config.ante);
});

test('mở hai lá vẫn chưa đủ, mở lá thứ ba thì đánh được', () => {
  const game = newGame(31);
  startRound(game);
  chayToiLuotNguoiThat(game);

  flipCards(game, 'p0', 0);
  flipCards(game, 'p0', 1);
  assert.equal(getLegalActions(game).canCall, false, '2/3 lá vẫn chưa đủ');

  flipCards(game, 'p0', 2);
  const legal = getLegalActions(game);
  assert.equal(legal.allRevealed, true);
  assert.equal(legal.canCall, true);
  assert.ok(applyAction(game, 'p0', { type: 'call', actionSeq: legal.actionSeq }).ok);
});

test('ÚP MÙ: chưa xem bài vẫn được úp, và có ghi nhận là úp mù', () => {
  const game = newGame(37);
  startRound(game);
  chayToiLuotNguoiThat(game);

  const legal = getLegalActions(game);
  assert.equal(legal.canFold, true, 'lúc nào cũng được úp mù');

  const res = applyAction(game, 'p0', { type: 'fold', actionSeq: legal.actionSeq });
  assert.ok(res.ok);
  const hanhDong = res.events.find((e) => e.type === 'action');
  assert.equal(hanhDong.action, 'fold');
  assert.equal(hanhDong.blind, true, 'phải đánh dấu là úp mù');
  assert.equal(getPlayer(game, 'p0').folded, true);
});

test('úp bài sau khi đã xem thì không tính là úp mù', () => {
  const game = newGame(41);
  startRound(game);
  chayToiLuotNguoiThat(game);
  flipCards(game, 'p0', 'all');

  const legal = getLegalActions(game);
  if (!legal.canFold) return; // không có gì để theo thì không úp được, bỏ qua
  const res = applyAction(game, 'p0', { type: 'fold', actionSeq: legal.actionSeq });
  assert.equal(res.events.find((e) => e.type === 'action').blind, false);
});

/* ================================================================== */
/*  HẾT GIỜ                                                            */
/* ================================================================== */

test('hết giờ thì lật hết bài ra cho thấy, rồi mới xử lý', () => {
  const game = newGame(43);
  startRound(game);
  chayToiLuotNguoiThat(game);

  const truoc = getLegalActions(game);
  assert.equal(truoc.allRevealed, false);

  const res = timeoutAction(game);
  assert.ok(res.ok, res.error);
  assert.ok(res.events.some((e) => e.type === 'timeout'));
  assert.ok(res.events.some((e) => e.type === 'flip'), 'phải lật bài ra trước');
  assert.equal(
    allRevealed(getPlayer(game, 'p0')), true,
    'hết giờ rồi thì được xem mình vừa bỏ lỡ cái gì',
  );
});

/* ================================================================== */
/*  CUỐI VÁN                                                           */
/* ================================================================== */

test('hết ván thì được xem lại bài của mình, kể cả lá chưa kịp lật', () => {
  const game = newGame(47, 2);
  startRound(game);

  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 30) {
    const actor = currentActor(game);
    const legal = getLegalActions(game);
    if (actor.id === 'p0') {
      // Người thật úp mù, không xem lá nào
      applyAction(game, 'p0', { type: 'fold', actionSeq: legal.actionSeq });
    } else {
      applyAction(game, actor.id, { type: 'call', actionSeq: legal.actionSeq });
    }
  }

  const me = getPlayer(game, 'p0');
  assert.equal(allRevealed(me), true, 'hết ván là được xem bài của chính mình');
  const mine = publicView(game, 'p0').players.find((p) => p.id === 'p0');
  assert.equal(mine.cards.filter(Boolean).length, 3);
});

test('lá chưa lật của mình không lộ cho người khác, kể cả khán giả', () => {
  const game = newGame(53, 3);
  startRound(game);
  flipCards(game, 'p0', 'all');

  for (const viewer of ['p1', 'p2', null]) {
    const view = publicView(game, viewer);
    const p0 = view.players.find((p) => p.id === 'p0');
    assert.equal(p0.cards, null, `bài của p0 lộ cho ${viewer ?? 'khán giả'}`);
    assert.equal(p0.revealedCount, 3, 'nhưng thấy được là họ đã mở mấy lá');
  }
});

test('người khác không lật bài hộ mình được', () => {
  const game = newGame(59, 3);
  startRound(game);
  // p1 cố lật bài của p0 — flipCards nhận playerId nên chỉ lật đúng bài của
  // người gửi lệnh; server truyền playerId từ phiên đăng nhập, không từ gói tin.
  flipCards(game, 'p1', 0);
  assert.equal(revealedCount(getPlayer(game, 'p0')), 0, 'bài p0 phải còn nguyên');
});
