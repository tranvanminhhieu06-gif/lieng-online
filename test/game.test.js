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
  PHASE,
} from '../src/engine/game.js';
import { decideBotAction } from '../src/engine/bot.js';

/**
 * Chia bài rồi lật hết bài của người thật.
 *
 * Từ khi bài được chia úp, người thật phải tự mở đủ 3 lá mới đặt cược được.
 * Các test trong file này kiểm tra vòng cược chứ không kiểm tra việc lật bài
 * (đã có test/flip.test.js lo), nên mở sẵn cho gọn.
 */
function startAndReveal(game) {
  const res = startRound(game);
  for (const p of game.players) {
    if (!p.isBot && p.inHand) flipCards(game, p.id, 'all');
  }
  return res;
}

function newGame(seed = 1, n = 4, config = {}) {
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({ id: `p${i}`, name: `P${i}`, isBot: i > 0 });
  }
  return createGame({ players, config, randomInt: seededRandomInt(seed) });
}

/** Bất biến quan trọng nhất: tiền không tự sinh ra và không tự mất đi. */
function totalChips(game) {
  return game.players.reduce((s, p) => s + p.chips, 0) + game.pot;
}

test('bắt đầu ván: chia đúng 3 lá, thu tiền sàn, đúng lượt đi', () => {
  const game = newGame(7);
  const bank = totalChips(game);
  const { ok, events } = startAndReveal(game);

  assert.ok(ok);
  assert.equal(game.phase, PHASE.BETTING);
  assert.equal(game.pot, 40, '4 người x tiền sàn 10');
  assert.equal(totalChips(game), bank, 'tổng tiền không đổi');
  for (const p of game.players) {
    assert.equal(p.hand.length, 3);
    assert.equal(p.chips, 490);
  }
  assert.ok(events.some((e) => e.type === 'deal'));
  assert.ok(currentActor(game), 'phải có người tới lượt');
});

test('không chia trùng lá bài', () => {
  for (let seed = 0; seed < 50; seed++) {
    const game = newGame(seed, 6);
    startAndReveal(game);
    const seen = new Set();
    for (const p of game.players) {
      for (const card of p.hand) {
        const code = `${card.rank}${card.suit}`;
        assert.ok(!seen.has(code), `lá ${code} bị chia hai lần (seed ${seed})`);
        seen.add(code);
      }
    }
    assert.equal(seen.size, 18);
  }
});

test('không thể đi khi chưa tới lượt', () => {
  const game = newGame(3);
  startAndReveal(game);
  const actor = currentActor(game);
  const other = game.players.find((p) => p.id !== actor.id);

  const res = applyAction(game, other.id, { type: 'call' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Chưa tới lượt/);
});

test('gửi lại hành động cũ (actionSeq lệch) bị bỏ qua', () => {
  const game = newGame(4);
  startAndReveal(game);
  const legal = getLegalActions(game);
  const first = applyAction(game, legal.playerId, { type: 'call', actionSeq: legal.actionSeq });
  assert.ok(first.ok);

  // Client gửi trùng gói tin cũ
  const replay = applyAction(game, legal.playerId, { type: 'call', actionSeq: legal.actionSeq });
  assert.equal(replay.ok, false);
});

test('mức tố ngoài khoảng cho phép bị từ chối', () => {
  const game = newGame(5);
  startAndReveal(game);
  const legal = getLegalActions(game);

  assert.equal(
    applyAction(game, legal.playerId, { type: 'raise', amount: legal.minRaise - 1 }).ok,
    false,
  );
  assert.equal(
    applyAction(game, legal.playerId, { type: 'raise', amount: legal.maxRaise + 1 }).ok,
    false,
  );
  assert.equal(
    applyAction(game, legal.playerId, { type: 'raise', amount: 999999 }).ok,
    false,
  );
  // Mức hợp lệ thì đi được
  assert.ok(applyAction(game, legal.playerId, { type: 'raise', amount: legal.minRaise }).ok);
});

test('chip không bao giờ âm dù tố tất tay', () => {
  const game = newGame(9, 3, { startChips: 55, ante: 10 });
  startAndReveal(game);
  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 100) {
    const legal = getLegalActions(game);
    const action = legal.canRaise
      ? { type: 'raise', amount: legal.maxRaise, actionSeq: legal.actionSeq }
      : { type: 'call', actionSeq: legal.actionSeq };
    applyAction(game, legal.playerId, action);
  }
  for (const p of game.players) {
    assert.ok(p.chips >= 0, `${p.id} có chip âm: ${p.chips}`);
  }
});

test('mọi người úp bài thì người còn lại ăn hũ, không lộ bài', () => {
  const game = newGame(11, 4);
  startAndReveal(game);
  const events = [];
  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 50) {
    const legal = getLegalActions(game);
    const live = game.players.filter((p) => p.inHand && !p.folded);
    const action =
      live.length > 1 && legal.canFold
        ? { type: 'fold', actionSeq: legal.actionSeq }
        : { type: 'call', actionSeq: legal.actionSeq };
    events.push(...applyAction(game, legal.playerId, action).events);
  }
  const showdown = events.find((e) => e.type === 'showdown');
  if (showdown && game.players.filter((p) => p.inHand && !p.folded).length === 1) {
    assert.equal(showdown.reveals.length, 0, 'thắng do người khác úp thì không cần lộ bài');
  }
});

test('publicView không để lộ bài của người khác', () => {
  const game = newGame(13, 4);
  startAndReveal(game);
  const view = publicView(game, 'p0');

  const me = view.players.find((p) => p.id === 'p0');
  assert.equal(me.cards.length, 3, 'phải thấy bài của chính mình');

  for (const p of view.players) {
    if (p.id === 'p0') continue;
    assert.equal(p.cards, null, `bài của ${p.id} bị lộ ra client!`);
    assert.equal(p.cardCount, 3, 'nhưng vẫn biết họ cầm mấy lá');
  }

  // Khán giả không thấy bài của ai
  const spectator = publicView(game, null);
  for (const p of spectator.players) {
    assert.equal(p.cards, null, 'khán giả không được thấy bài');
  }
});

test('publicView chỉ gửi `legal` cho đúng người đang tới lượt', () => {
  const game = newGame(17, 4);
  startAndReveal(game);
  const turnId = currentActor(game).id;
  for (const p of game.players) {
    const view = publicView(game, p.id);
    if (p.id === turnId) assert.ok(view.legal, 'người tới lượt phải có legal');
    else assert.equal(view.legal, null);
  }
});

test('hết giờ: có tiền phải theo thì tự úp, không thì giữ bài', () => {
  const game = newGame(19, 4);
  startAndReveal(game);

  // Người đầu tiên tố lên để người sau có tiền phải theo
  const first = getLegalActions(game);
  applyAction(game, first.playerId, { type: 'raise', amount: first.minRaise });

  const second = getLegalActions(game);
  assert.ok(second.callAmount > 0);
  const res = timeoutAction(game);
  assert.ok(res.ok);
  assert.ok(res.events.some((e) => e.type === 'timeout'));
  assert.equal(
    game.players.find((p) => p.id === second.playerId).folded,
    true,
    'hết giờ mà đang có tiền phải theo thì bị úp bài',
  );
});

test('chơi trọn 300 ván với bot: tiền luôn bảo toàn, không có chip âm', () => {
  for (let seed = 0; seed < 30; seed++) {
    const game = newGame(seed, 4);
    const bank = totalChips(game);
    const random = () => seededRandomInt(seed + 7)(1000) / 1000;

    let rounds = 0;
    while (game.phase !== PHASE.GAME_OVER && rounds < 10) {
      const started = startAndReveal(game);
      if (!started.ok) break;
      rounds++;

      let guard = 0;
      while (game.phase === PHASE.BETTING && guard++ < 200) {
        const legal = getLegalActions(game);
        const actor = currentActor(game);
        const action = decideBotAction(actor, legal, {
          ante: game.config.ante,
          random: Math.random,
        });
        const res = applyAction(game, legal.playerId, action);
        assert.ok(res.ok, `hành động của bot bị từ chối: ${res.error}`);
      }
      assert.ok(guard < 200, 'vòng cược không kết thúc — nghi ngờ vòng lặp vô hạn');

      assert.equal(game.pot, 0, 'chia hết hũ sau mỗi ván');
      assert.equal(totalChips(game), bank, `tiền không bảo toàn ở seed ${seed}`);
      for (const p of game.players) {
        assert.ok(p.chips >= 0, `${p.id} chip âm ở seed ${seed}`);
      }
    }
  }
});

test('người bị loại khi hết tiền, game kết thúc khi còn một người', () => {
  const game = newGame(23, 2, { startChips: 20, ante: 10 });
  let guard = 0;
  while (game.phase !== PHASE.GAME_OVER && guard++ < 40) {
    const started = startAndReveal(game);
    if (!started.ok) break;
    let g2 = 0;
    while (game.phase === PHASE.BETTING && g2++ < 50) {
      const legal = getLegalActions(game);
      const action = legal.canRaise
        ? { type: 'raise', amount: legal.maxRaise, actionSeq: legal.actionSeq }
        : { type: 'call', actionSeq: legal.actionSeq };
      applyAction(game, legal.playerId, action);
    }
  }
  assert.equal(game.phase, PHASE.GAME_OVER);
  assert.equal(game.players.filter((p) => !p.eliminated).length, 1);
});

test('hũ phụ hoạt động trong ván thật: người tất tay ít không ăn quá phần mình', () => {
  const game = createGame({
    players: [
      { id: 'short', name: 'Ít tiền', chips: 30 },
      { id: 'rich1', name: 'Nhiều tiền 1', chips: 500 },
      { id: 'rich2', name: 'Nhiều tiền 2', chips: 500 },
    ],
    config: { ante: 10, maxRaises: 6 },
    randomInt: seededRandomInt(31),
  });
  const bank = totalChips(game);
  startAndReveal(game);

  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 60) {
    const legal = getLegalActions(game);
    const action = legal.canRaise
      ? { type: 'raise', amount: legal.maxRaise, actionSeq: legal.actionSeq }
      : { type: 'call', actionSeq: legal.actionSeq };
    applyAction(game, legal.playerId, action);
  }

  const short = game.players.find((p) => p.id === 'short');
  assert.ok(short.chips <= 90, `short chỉ có thể ăn tối đa 3 x 30 = 90, đang có ${short.chips}`);
  assert.equal(totalChips(game), bank);
  assert.equal(game.pot, 0);
  assert.ok(game.lastResult.pots.length >= 1);
});

test('bàn 10 người: chia đủ 30 lá, thu đủ tiền sàn và chơi trọn ván', () => {
  const game = newGame(99, 10, { maxPlayers: 10, ante: 20, startChips: 1000 });
  assert.equal(game.players.length, 10);
  const bank = totalChips(game);
  const { ok } = startAndReveal(game);
  assert.ok(ok);
  assert.equal(game.pot, 200, '10 người x 20 ante = 200');
  assert.equal(totalChips(game), bank);

  const allCards = new Set();
  for (const p of game.players) {
    assert.equal(p.hand.length, 3);
    for (const c of p.hand) {
      const key = `${c.rank}-${c.suit}`;
      assert.ok(!allCards.has(key), `Trùng lá ${key}`);
      allCards.add(key);
    }
  }
  assert.equal(allCards.size, 30, 'Đúng 30 lá bài riêng biệt từ bộ bài');

  let guard = 0;
  while (game.phase === PHASE.BETTING && guard++ < 100) {
    const actor = currentActor(game);
    if (!actor) break;
    const legal = getLegalActions(game);
    const action = decideBotAction(actor, legal, { ante: 20 });
    applyAction(game, actor.id, action);
  }

  assert.ok(game.phase === PHASE.ROUND_OVER || game.phase === PHASE.GAME_OVER);
  assert.equal(totalChips(game), bank, 'Tiền bảo toàn sau ván 10 người');
});
