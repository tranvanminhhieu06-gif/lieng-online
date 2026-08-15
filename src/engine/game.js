/**
 * Máy trạng thái của một ván Liêng.
 *
 * Khác biệt lớn nhất so với bản prototype offline: ở đây KHÔNG có `await`.
 * Bản cũ dùng `await awaitPlayerAction()` nên vòng cược treo lại chờ người
 * chơi bấm nút — không dùng được cho server nhiều phòng, không đặt được đồng
 * hồ, không kết nối lại được.
 *
 * Ở đây mọi thứ là hàm thuần trên một object state:
 *
 *     startRound(game)                  -> events[]
 *     getLegalActions(game)             -> hành động hợp lệ của người đang tới lượt
 *     applyAction(game, playerId, act)  -> { ok, error, events }
 *     publicView(game, viewerId)        -> state đã lọc, an toàn để gửi cho client
 *
 * Server gọi các hàm này rồi phát `events` cho client. Client không giữ
 * bất kỳ logic luật nào.
 */

import { buildDeck, shuffle } from './cards.js';
import { evaluateHand } from './evaluate.js';
import { buildPots, awardPots } from './pots.js';

export const PHASE = {
  WAITING: 'waiting',   // chưa đủ người
  BETTING: 'betting',   // đang đặt cược
  SHOWDOWN: 'showdown', // đang ngửa bài
  ROUND_OVER: 'roundOver',
  GAME_OVER: 'gameOver',
};

export const DEFAULT_CONFIG = {
  ante: 10,
  startChips: 500,
  maxRaises: 4,        // số lần tố tối đa trong một ván
  minPlayers: 2,
  maxPlayers: 6,
  tiebreakBySuit: true,
};

/**
 * @param {{
 *   players?: {id:string, name:string, isBot?:boolean, chips?:number}[],
 *   config?: object,
 *   randomInt: (n:number)=>number
 * }} opts
 */
export function createGame({ players = [], config = {}, randomInt } = {}) {
  if (typeof randomInt !== 'function') {
    throw new Error('createGame() cần randomInt(n)');
  }
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const game = {
    config: cfg,
    randomInt,
    phase: PHASE.WAITING,
    players: [],
    seatOrder: [],
    order: [],
    actingIndex: -1,
    needsToAct: new Set(),
    deck: [],
    pot: 0,
    currentBet: 0,
    raiseCount: 0,
    roundNum: 0,
    dealerIndex: -1,
    actionSeq: 0,
    lastResult: null,
  };
  for (const p of players) addPlayer(game, p);
  return game;
}

export function addPlayer(game, { id, name, isBot = false, chips }) {
  if (game.players.some((p) => p.id === id)) {
    throw new Error(`Người chơi ${id} đã có trong bàn`);
  }
  if (game.players.length >= game.config.maxPlayers) {
    throw new Error('Bàn đã đầy');
  }
  const player = {
    id,
    name,
    isBot,
    seat: game.players.length,
    chips: chips ?? game.config.startChips,
    hand: [],
    folded: false,
    allIn: false,
    inHand: false,
    eliminated: false,
    betThisRound: 0,
    committed: 0,
    reveal: null,
    // Từng lá đã được chính chủ lật lên chưa. Lá chưa lật thì server KHÔNG
    // gửi xuống client — mở DevTools cũng không xem trước được.
    revealed: [false, false, false],
    // Thống kê tích luỹ trong phòng
    stats: { roundsPlayed: 0, roundsWon: 0, chipsWon: 0, chipsLost: 0 },
  };
  game.players.push(player);
  game.seatOrder.push(id);
  return player;
}

export function removePlayer(game, id) {
  const idx = game.players.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  game.players.splice(idx, 1);
  game.seatOrder = game.seatOrder.filter((x) => x !== id);
  game.order = game.order.filter((x) => x !== id);
  game.needsToAct.delete(id);
  game.players.forEach((p, i) => { p.seat = i; });
  return true;
}

export function getPlayer(game, id) {
  return game.players.find((p) => p.id === id) ?? null;
}

/** Những người còn tiền và sẵn sàng vào ván mới. */
export function activePlayers(game) {
  return game.players.filter((p) => !p.eliminated);
}

/** Những người vẫn còn trong ván đang chơi (chưa úp bài). */
export function liveInHand(game) {
  return game.players.filter((p) => p.inHand && !p.folded);
}

export function canStartRound(game) {
  if (game.phase === PHASE.BETTING || game.phase === PHASE.SHOWDOWN) return false;
  return activePlayers(game).length >= game.config.minPlayers;
}

/* ================================================================== */
/*  BẮT ĐẦU VÁN                                                        */
/* ================================================================== */

export function startRound(game) {
  if (!canStartRound(game)) {
    return { ok: false, error: 'Chưa đủ người để bắt đầu ván', events: [] };
  }

  const events = [];
  const contenders = activePlayers(game);

  // Reset trạng thái ván
  for (const p of game.players) {
    p.hand = [];
    p.folded = false;
    p.allIn = false;
    p.betThisRound = 0;
    p.committed = 0;
    p.reveal = null;
    // Bot "nhìn" bài ngay — bài của bot vốn không bao giờ gửi xuống client
    // trước lúc ngửa bài, nên không có gì để giấu.
    p.revealed = p.isBot ? [true, true, true] : [false, false, false];
    p.inHand = !p.eliminated;
  }
  game.pot = 0;
  game.currentBet = 0;
  game.raiseCount = 0;
  game.lastResult = null;
  game.roundNum += 1;
  game.deck = shuffle(buildDeck(), game.randomInt);

  // Xoay nút chia bài
  game.dealerIndex =
    game.dealerIndex < 0
      ? 0
      : (game.dealerIndex + 1) % Math.max(1, game.players.length);
  // Nếu người ở vị trí nút đã bị loại thì đẩy tiếp
  let guard = 0;
  while (game.players[game.dealerIndex]?.eliminated && guard++ < game.players.length) {
    game.dealerIndex = (game.dealerIndex + 1) % game.players.length;
  }
  const dealer = game.players[game.dealerIndex];

  events.push({
    type: 'round-start',
    roundNum: game.roundNum,
    ante: game.config.ante,
    dealerId: dealer?.id ?? null,
  });

  // Đặt tiền sàn
  for (const p of contenders) {
    const amount = Math.min(game.config.ante, p.chips);
    p.chips -= amount;
    p.betThisRound = amount;
    p.committed = amount;
    game.pot += amount;
    if (p.chips === 0) p.allIn = true;
    p.stats.roundsPlayed += 1;
    events.push({ type: 'ante', playerId: p.id, amount });
  }
  game.currentBet = Math.max(...contenders.map((p) => p.betThisRound), 0);

  // Chia bài
  for (const p of contenders) {
    p.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
  }
  events.push({ type: 'deal', playerIds: contenders.map((p) => p.id) });

  // Thứ tự hành động: bắt đầu từ người sau nút chia bài
  game.order = buildActionOrder(game, contenders);
  game.needsToAct = new Set(
    contenders.filter((p) => !p.allIn).map((p) => p.id),
  );
  game.actingIndex = -1;
  game.phase = PHASE.BETTING;

  const next = advanceTurn(game);
  if (!next) {
    // Tất cả đều tất tay ngay từ tiền sàn -> ngửa bài luôn
    events.push(...settleRound(game));
  } else {
    events.push({ type: 'turn', playerId: next.id });
  }

  return { ok: true, events };
}

function buildActionOrder(game, contenders) {
  const ids = contenders.map((p) => p.id);
  const n = game.players.length;
  const order = [];
  for (let i = 1; i <= n; i++) {
    const p = game.players[(game.dealerIndex + i) % n];
    if (p && ids.includes(p.id)) order.push(p.id);
  }
  return order;
}

/* ================================================================== */
/*  LƯỢT ĐI                                                            */
/* ================================================================== */

/* ================================================================== */
/*  LẬT BÀI                                                            */
/* ================================================================== */

export function allRevealed(player) {
  return player.hand.length > 0 && player.revealed.every(Boolean);
}

export function revealedCount(player) {
  return player.revealed.filter(Boolean).length;
}

/**
 * Người chơi tự lật bài của mình.
 *
 * @param {object} game
 * @param {string} playerId
 * @param {number|'all'} which  chỉ số lá (0-2) hoặc 'all' để lật hết
 * @returns {{ok:boolean, error?:string, events:object[]}}
 */
export function flipCards(game, playerId, which) {
  const p = getPlayer(game, playerId);
  if (!p) return { ok: false, error: 'Không tìm thấy người chơi', events: [] };
  if (!p.inHand || p.hand.length === 0) {
    return { ok: false, error: 'Bạn chưa có bài để lật', events: [] };
  }

  // Phải là số nguyên thật. Không dùng Number(which) vì Number(null) === 0,
  // gói tin thiếu chỉ số sẽ lật nhầm lá đầu tiên.
  const hopLe =
    typeof which === 'number' &&
    Number.isInteger(which) &&
    which >= 0 &&
    which < p.hand.length;
  const targets = which === 'all' ? [0, 1, 2] : hopLe ? [which] : [];

  if (targets.length === 0) {
    return { ok: false, error: 'Không có lá bài nào ở vị trí đó', events: [] };
  }

  const flipped = targets.filter((i) => !p.revealed[i]);
  if (flipped.length === 0) {
    return { ok: false, error: 'Lá bài đó đã lật rồi', events: [] };
  }
  for (const i of flipped) p.revealed[i] = true;

  return {
    ok: true,
    events: [
      {
        type: 'flip',
        playerId: p.id,
        indexes: flipped,
        revealedCount: revealedCount(p),
      },
    ],
  };
}

export function currentActor(game) {
  if (game.phase !== PHASE.BETTING) return null;
  if (game.actingIndex < 0 || game.actingIndex >= game.order.length) return null;
  return getPlayer(game, game.order[game.actingIndex]);
}

/**
 * Tìm người tiếp theo phải hành động. Trả về null nếu vòng cược đã xong.
 */
function advanceTurn(game) {
  const n = game.order.length;
  if (n === 0) return null;
  if (liveInHand(game).length <= 1) return null;

  const start = game.actingIndex;
  for (let step = 1; step <= n; step++) {
    const idx = (start + step + n) % n;
    const p = getPlayer(game, game.order[idx]);
    if (!p) continue;
    if (p.folded || p.allIn || !p.inHand) continue;
    if (!game.needsToAct.has(p.id)) continue;
    game.actingIndex = idx;
    return p;
  }
  return null;
}

/**
 * Các hành động hợp lệ của người đang tới lượt.
 * Client dùng cái này để dựng nút bấm; server dùng nó để kiểm tra.
 */
export function getLegalActions(game) {
  const actor = currentActor(game);
  if (!actor) return null;

  const callAmount = Math.max(0, game.currentBet - actor.betThisRound);
  const payToCall = Math.min(callAmount, actor.chips);
  const maxRaise = actor.betThisRound + actor.chips;
  const minRaise = game.currentBet + game.config.ante;
  const seen = allRevealed(actor);
  const raiseAllowed =
    seen && game.raiseCount < game.config.maxRaises && maxRaise > game.currentBet;

  return {
    playerId: actor.id,
    actionSeq: game.actionSeq,
    callAmount,
    payToCall,
    isAllInCall: callAmount > 0 && callAmount >= actor.chips,
    // Úp bài lúc nào cũng được. Trước đây nút Úp bị khoá khi không có gì phải
    // theo, nên xem bài xấu ngay vòng đầu mà chưa ai tố thì không bỏ được —
    // bắt buộc phải giữ bài tới cuối ván.
    canFold: true,
    canCall: seen,
    canRaise: raiseAllowed,
    allRevealed: seen,
    revealedCount: revealedCount(actor),
    minRaise: raiseAllowed ? Math.min(minRaise, maxRaise) : 0,
    maxRaise: raiseAllowed ? maxRaise : 0,
    raiseStep: game.config.ante,
    raisesLeft: Math.max(0, game.config.maxRaises - game.raiseCount),
  };
}

const MUST_REVEAL = 'Hãy mở hết 3 lá bài trước khi đặt cược';

/**
 * Áp dụng một hành động.
 *
 * @param {object} game
 * @param {string} playerId
 * @param {{type:'fold'|'call'|'raise', amount?:number, actionSeq?:number}} action
 */
export function applyAction(game, playerId, action) {
  if (game.phase !== PHASE.BETTING) {
    return { ok: false, error: 'Hiện không phải lúc đặt cược', events: [] };
  }
  const actor = currentActor(game);
  if (!actor) {
    return { ok: false, error: 'Không có ai đang tới lượt', events: [] };
  }
  if (actor.id !== playerId) {
    return { ok: false, error: 'Chưa tới lượt của bạn', events: [] };
  }
  // Chống gửi trùng / gửi lại hành động cũ
  if (
    action.actionSeq !== undefined &&
    action.actionSeq !== null &&
    action.actionSeq !== game.actionSeq
  ) {
    return { ok: false, error: 'Hành động đã cũ, bỏ qua', events: [] };
  }

  const legal = getLegalActions(game);
  const events = [];

  switch (action.type) {
    case 'fold': {
      actor.folded = true;
      events.push({
        type: 'action',
        playerId: actor.id,
        action: 'fold',
        blind: !legal.allRevealed, // úp mù, chưa xem bài
      });
      break;
    }

    case 'call': {
      if (!legal.canCall) return { ok: false, error: MUST_REVEAL, events: [] };
      const res = applyCall(game, actor, legal, events);
      if (!res.ok) return res;
      break;
    }

    case 'raise': {
      if (!legal.allRevealed) return { ok: false, error: MUST_REVEAL, events: [] };
      if (!legal.canRaise) {
        return { ok: false, error: 'Không thể tố lúc này', events: [] };
      }
      let target = Number(action.amount);
      if (!Number.isFinite(target)) {
        return { ok: false, error: 'Mức tố không hợp lệ', events: [] };
      }
      target = Math.round(target);
      if (target < legal.minRaise || target > legal.maxRaise) {
        return {
          ok: false,
          error: `Mức tố phải trong khoảng ${legal.minRaise}–${legal.maxRaise}`,
          events: [],
        };
      }
      const pay = target - actor.betThisRound;
      actor.chips -= pay;
      actor.betThisRound += pay;
      actor.committed += pay;
      game.pot += pay;
      if (actor.chips === 0) actor.allIn = true;
      game.currentBet = actor.betThisRound;
      game.raiseCount += 1;
      events.push({
        type: 'action',
        playerId: actor.id,
        action: actor.allIn ? 'allin-raise' : 'raise',
        amount: pay,
        total: actor.betThisRound,
      });
      // Tố lại mở lại lượt cho những người khác
      for (const p of game.players) {
        if (p.inHand && !p.folded && !p.allIn && p.id !== actor.id) {
          game.needsToAct.add(p.id);
        }
      }
      break;
    }

    default:
      return { ok: false, error: `Hành động lạ: ${action.type}`, events: [] };
  }

  game.needsToAct.delete(actor.id);
  game.actionSeq += 1;

  const next = advanceTurn(game);
  if (next) {
    events.push({ type: 'turn', playerId: next.id });
  } else {
    events.push(...settleRound(game));
  }

  return { ok: true, events };
}

function applyCall(game, actor, legal, events) {
  const pay = legal.payToCall;
  actor.chips -= pay;
  actor.betThisRound += pay;
  actor.committed += pay;
  game.pot += pay;
  if (actor.chips === 0) actor.allIn = true;
  events.push({
    type: 'action',
    playerId: actor.id,
    action: pay === 0 ? 'check' : actor.allIn ? 'allin-call' : 'call',
    amount: pay,
    total: actor.betThisRound,
  });
  return { ok: true, events };
}

/**
 * Hết giờ suy nghĩ: lật hết bài ra cho người chơi thấy mình vừa bỏ lỡ cái gì,
 * rồi không có gì để theo thì giữ bài, có thì úp.
 */
export function timeoutAction(game) {
  let legal = getLegalActions(game);
  if (!legal) return { ok: false, error: 'Không có ai đang tới lượt', events: [] };

  const before = [];
  if (!legal.allRevealed) {
    const flip = flipCards(game, legal.playerId, 'all');
    if (flip.ok) before.push(...flip.events);
    legal = getLegalActions(game);
  }

  const type = legal.callAmount > 0 ? 'fold' : 'call';
  const res = applyAction(game, legal.playerId, { type, actionSeq: legal.actionSeq });
  if (res.ok) {
    res.events.unshift({ type: 'timeout', playerId: legal.playerId }, ...before);
  }
  return res;
}

/* ================================================================== */
/*  NGỬA BÀI & CHIA TIỀN                                               */
/* ================================================================== */

function settleRound(game) {
  game.phase = PHASE.SHOWDOWN;
  const events = [];

  const contenders = game.players.filter((p) => p.inHand);
  const live = contenders.filter((p) => !p.folded);

  // Hết ván thì ai cũng được xem lại bài của chính mình, kể cả lá chưa kịp lật
  // hay vừa úp mù.
  for (const p of contenders) p.revealed = [true, true, true];

  const pots = buildPots(
    contenders.map((p) => ({
      id: p.id,
      committed: p.committed,
      folded: p.folded,
    })),
  );

  const handsById = {};
  const reveals = [];
  const contested = pots.some((pot) => pot.eligible.length > 1);

  if (live.length > 1 || contested) {
    for (const p of live) {
      const res = evaluateHand(p.hand, {
        tiebreakBySuit: game.config.tiebreakBySuit,
      });
      handsById[p.id] = res;
      p.reveal = res;
      reveals.push({ playerId: p.id, cards: p.hand.slice(), hand: res });
    }
    events.push({ type: 'showdown', reveals });
  } else {
    // Chỉ còn một người -> không cần lộ bài
    for (const p of live) handsById[p.id] = { category: 0, tiebreak: [0] };
    events.push({ type: 'showdown', reveals: [] });
  }

  const { payouts, details } = awardPots(pots, handsById, game.seatOrder);

  const totalPot = game.pot;
  for (const p of game.players) {
    const won = payouts[p.id] ?? 0;
    if (won > 0) {
      p.chips += won;
      events.push({ type: 'payout', playerId: p.id, amount: won });
    }
  }
  game.pot = 0;

  const winnerIds = [...new Set(details.flatMap((d) => d.winners))];
  const bonus = applyWinBonus(game, { reveals, live, winnerIds, events });

  // Thống kê tính sau khi đã cộng thưởng nhân, để con số lãi/lỗ là con số thật
  for (const p of game.players) {
    if (!p.inHand) continue;
    const won = (payouts[p.id] ?? 0) + (bonus?.thu?.[p.id] ?? 0) - (bonus?.tra?.[p.id] ?? 0);
    const net = won - p.committed;
    if (net > 0) {
      p.stats.chipsWon += net;
      p.stats.roundsWon += 1;
    } else {
      p.stats.chipsLost += -net;
    }
  }
  game.lastResult = {
    roundNum: game.roundNum,
    totalPot,
    pots: details,
    winnerIds,
    reveals: reveals.map((r) => ({
      playerId: r.playerId,
      cards: r.cards,
      label: r.hand.label,
      categoryName: r.hand.categoryName,
    })),
    committed: Object.fromEntries(contenders.map((p) => [p.id, p.committed])),
    bonus,
  };

  events.push({
    type: 'round-end',
    roundNum: game.roundNum,
    totalPot,
    winnerIds,
    pots: details,
  });

  // Loại người hết tiền
  for (const p of game.players) {
    if (!p.eliminated && p.chips <= 0) {
      p.eliminated = true;
      p.inHand = false;
      events.push({ type: 'eliminated', playerId: p.id });
    }
  }

  const remaining = activePlayers(game);
  if (remaining.length <= 1) {
    game.phase = PHASE.GAME_OVER;
    events.push({
      type: 'game-over',
      winnerId: remaining[0]?.id ?? null,
    });
  } else {
    game.phase = PHASE.ROUND_OVER;
  }

  return events;
}

/**
 * Thưởng nhân khi thắng bằng bài đẹp: Sáp ăn gấp đôi, Liêng đồng chất ăn gấp
 * rưỡi.
 *
 * Tiền thưởng do NGƯỜI THUA TRẢ THÊM, không phải hệ thống bù — nếu hệ thống bù
 * thì tổng xu toàn game cứ phình lên mãi. Mỗi người thua trả thêm phần tương
 * ứng với số tiền chính họ đã bỏ vào hũ, và không bao giờ trả quá số chip còn
 * lại của mình.
 *
 * Chỉ tính khi CÓ NGỬA BÀI. Mọi người úp hết thì bài không lộ ra, không ai biết
 * người thắng cầm gì, trả thưởng lúc đó vừa vô lý vừa dễ bị lợi dụng.
 * Hoà (nhiều người cùng thắng) cũng không tính, cho khỏi rối.
 *
 * @returns {{playerId:string, multiplier:number, total:number, thu:object, tra:object}|null}
 */
function applyWinBonus(game, { reveals, live, winnerIds, events }) {
  if (reveals.length < 2) return null;      // không ngửa bài thì thôi
  if (winnerIds.length !== 1) return null;  // hoà thì thôi

  const winner = getPlayer(game, winnerIds[0]);
  const heSo = winner?.reveal?.multiplier ?? 1;
  if (!winner || heSo <= 1) return null;

  const tra = {};
  let tong = 0;
  for (const p of live) {
    if (p.id === winner.id) continue;
    const phaiTra = Math.min(Math.round(p.committed * (heSo - 1)), p.chips);
    if (phaiTra <= 0) continue;
    p.chips -= phaiTra;
    tra[p.id] = phaiTra;
    tong += phaiTra;
  }
  if (tong <= 0) return null;

  winner.chips += tong;
  const bonus = {
    playerId: winner.id,
    multiplier: heSo,
    label: winner.reveal.label,
    total: tong,
    thu: { [winner.id]: tong },
    tra,
  };
  events.push({ type: 'bonus', ...bonus });
  return bonus;
}

/* ================================================================== */
/*  VIEW GỬI CHO CLIENT                                                */
/* ================================================================== */

/**
 * Trả về state đã lọc, an toàn để gửi qua mạng.
 *
 * Đây là hàng rào chống gian lận quan trọng nhất: bài của người khác KHÔNG
 * bao giờ rời khỏi server cho tới khi ngửa bài. Bản prototype cũ gửi hết bài
 * cho client rồi chỉ giấu bằng CSS — mở DevTools là thấy hết.
 *
 * @param {object} game
 * @param {string|null} viewerId  null = khán giả
 */
export function publicView(game, viewerId = null) {
  const actor = currentActor(game);
  return {
    phase: game.phase,
    roundNum: game.roundNum,
    pot: game.pot,
    currentBet: game.currentBet,
    ante: game.config.ante,
    maxRaises: game.config.maxRaises,
    raiseCount: game.raiseCount,
    actionSeq: game.actionSeq,
    dealerId: game.players[game.dealerIndex]?.id ?? null,
    turnPlayerId: actor?.id ?? null,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      seat: p.seat,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      inHand: p.inHand,
      eliminated: p.eliminated,
      betThisRound: p.betThisRound,
      committed: p.committed,
      cardCount: p.hand.length,
      // Ngửa bài cuối ván thì ai cũng thấy; còn lại chỉ thấy bài của chính
      // mình, và chỉ những lá mình đã tự lật lên.
      cards: p.reveal
        ? p.hand.slice()
        : p.id === viewerId
          ? p.hand.map((card, i) => (p.revealed[i] ? card : null))
          : null,
      revealedCount: revealedCount(p),
      handLabel: p.reveal ? p.reveal.label : null,
      stats: { ...p.stats },
    })),
    legal:
      actor && actor.id === viewerId ? getLegalActions(game) : null,
    lastResult: game.lastResult,
  };
}
