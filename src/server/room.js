/**
 * Phòng chơi — nơi engine gặp mạng.
 *
 * Trách nhiệm:
 *  - giữ một ván Liêng (engine) và là nguồn sự thật duy nhất
 *  - đồng hồ đếm lượt + tự động úp bài khi hết giờ
 *  - điều khiển bot
 *  - cho phép kết nối lại bằng token mà không mất ghế
 *  - khán giả, chat, lịch sử ván
 */

import {
  createGame,
  addPlayer,
  removePlayer,
  startRound,
  applyAction,
  getLegalActions,
  currentActor,
  publicView,
  timeoutAction,
  flipCards,
  getPlayer,
  activePlayers,
  canStartRound,
  PHASE,
  DEFAULT_CONFIG,
} from '../engine/game.js';
import { decideBotAction, botThinkDelay, BOT_NAMES } from '../engine/bot.js';
import { cryptoRandomInt, cryptoRandom, makeToken, makeId } from './rng.js';
import { BOT_STACK_MULTIPLIER, tierRoomConfig } from './tiers.js';

/** 12345 -> "12.345" cho dễ đọc trong thông báo. */
const fmt = (n) => Number(n).toLocaleString('vi-VN');

export const ROOM_DEFAULTS = {
  ...DEFAULT_CONFIG,
  turnSeconds: 25,          // thời gian suy nghĩ mỗi lượt
  nextRoundDelaySeconds: 6, // nghỉ giữa hai ván
  disconnectGraceSeconds: 90,
  autoStart: true,
  historyLimit: 50,
};

export class Room {
  /**
   * @param {string} code
   * @param {object} config
   * @param {(room: Room) => void} onEmpty  gọi khi phòng không còn ai
   */
  constructor(code, config = {}, onEmpty = () => {}, opts = {}) {
    this.code = code;
    this.config = { ...ROOM_DEFAULTS, ...config };
    this.onEmpty = onEmpty;
    this.createdAt = Date.now();

    // Bàn công khai theo mức: chip trên bàn CHÍNH LÀ số dư tài khoản.
    // Phòng riêng theo mã mời thì không — chip ở đó là chip vui, không đụng ví.
    this.tier = opts.tier ?? null;
    this.store = opts.store ?? null;
    this.walletMode = !!(this.tier && this.store);
    /** @type {Map<string, number>} playerId -> accountId (chỉ ở bàn công khai) */
    this.accountOf = new Map();

    this.game = createGame({
      config: this.config,
      randomInt: cryptoRandomInt,
    });

    /** @type {Map<string, {ws:any, token:string, online:boolean, lastSeen:number}>} */
    this.seats = new Map();      // playerId -> kết nối
    /** @type {Map<string, {ws:any, name:string}>} */
    this.spectators = new Map(); // spectatorId -> kết nối
    this.tokens = new Map();     // token -> playerId

    this.hostId = null;
    this.history = [];
    this.chatLog = [];

    this.turnTimer = null;
    this.turnDeadline = null;
    this.botTimer = null;
    this.nextRoundTimer = null;
    this.reapTimer = null;
    this.closed = false;
  }

  /* ---------------------------------------------------------------- */
  /*  VÀO / RA PHÒNG                                                   */
  /* ---------------------------------------------------------------- */

  get humanCount() {
    return [...this.seats.keys()].filter((id) => !getPlayer(this.game, id)?.isBot)
      .length;
  }

  get onlineHumanCount() {
    let n = 0;
    for (const [, conn] of this.seats) if (conn.online) n++;
    return n;
  }

  isFull() {
    return this.game.players.length >= this.config.maxPlayers;
  }

  /**
   * Người mới ngồi vào bàn. Trả về { playerId, token }.
   *
   * @param {string} name
   * @param {{id:number, balance:number}|null} account
   *   Bắt buộc ở bàn công khai — chip trên bàn lấy thẳng từ số dư tài khoản.
   */
  joinAsPlayer(name, account = null) {
    if (this.isFull()) throw new Error('Bàn đã đầy');

    let chips;
    if (this.walletMode) {
      if (!account) throw new Error('Bàn này cần đăng nhập');
      // Số dư do index.js đọc mới từ CSDL ngay trước khi gọi hàm này. Không tự
      // đọc ở đây để giữ hàm đồng bộ — logic ván bài không được chờ mạng.
      const balance = account.balance;
      if (typeof balance !== 'number') throw new Error('Không đọc được số dư');
      if (balance < this.tier.minBalance) {
        throw new Error(
          `Bàn ${this.tier.label} cần tối thiểu ${fmt(this.tier.minBalance)} xu, bạn đang có ${fmt(balance)} xu`,
        );
      }
      chips = balance;
    }

    const id = makeId('p');
    const token = makeToken();
    addPlayer(this.game, { id, name: sanitizeName(name), isBot: false, chips });
    this.seats.set(id, { ws: null, token, online: false, lastSeen: Date.now() });
    this.tokens.set(token, id);
    if (account) this.accountOf.set(id, account.id);
    if (!this.hostId) this.hostId = id;
    return { playerId: id, token };
  }

  /** Gắn websocket vào một ghế (lần đầu hoặc sau khi rớt mạng). */
  attach(playerId, ws) {
    const conn = this.seats.get(playerId);
    if (!conn) return false;
    if (conn.ws && conn.ws !== ws) {
      try { conn.ws.close(4001, 'Ghế này vừa được mở ở nơi khác'); } catch {}
    }
    conn.ws = ws;
    conn.online = true;
    conn.lastSeen = Date.now();
    return true;
  }

  /** Nhận lại ghế bằng token sau khi rớt mạng. */
  resume(token, ws) {
    const playerId = this.tokens.get(token);
    if (!playerId) return null;
    if (!this.seats.has(playerId)) return null;
    this.attach(playerId, ws);
    return playerId;
  }

  detach(playerId) {
    const conn = this.seats.get(playerId);
    if (!conn) return;
    conn.ws = null;
    conn.online = false;
    conn.lastSeen = Date.now();
    this.scheduleReap();
  }

  /** Dọn những ghế đã offline quá lâu. */
  scheduleReap() {
    clearTimeout(this.reapTimer);
    this.reapTimer = setTimeout(() => {
      const cutoff = Date.now() - this.config.disconnectGraceSeconds * 1000;
      let changed = false;
      for (const [id, conn] of [...this.seats]) {
        if (conn.online) continue;
        if (conn.lastSeen > cutoff) continue;
        const p = getPlayer(this.game, id);
        // Không đá người đang trong ván dở — chờ hết ván
        if (p?.inHand && this.game.phase === PHASE.BETTING) continue;
        this.removeSeat(id, 'mất kết nối quá lâu');
        changed = true;
      }
      if (changed) this.broadcastState();
      if (this.seats.size === 0 && this.spectators.size === 0) {
        this.destroy();
      } else if ([...this.seats.values()].some((c) => !c.online)) {
        this.scheduleReap();
      }
    }, 15000);
    if (this.reapTimer.unref) this.reapTimer.unref();
  }

  /**
   * @param {string} playerId
   * @param {string} reason
   * @param {{notify?:boolean}} opts
   *   notify=false khi người chơi tự bấm rời bàn — họ đã biết rồi.
   *
   * Lưu ý: KHÔNG đóng WebSocket ở đây. Mất ghế không có nghĩa là mất kết nối —
   * người chơi vẫn cần kết nối đó để quay về sảnh.
   */
  removeSeat(playerId, reason = '', { notify = true } = {}) {
    const p = getPlayer(this.game, playerId);
    // Chốt sổ trước khi rời ghế, phòng khi rời giữa chừng.
    this.syncOneWallet(playerId);
    this.accountOf.delete(playerId);
    const conn = this.seats.get(playerId);
    if (conn) {
      this.tokens.delete(conn.token);
      if (notify && conn.ws) {
        send(conn.ws, { t: 'kicked-from-table', reason: reason || 'Bạn đã rời bàn.' });
      }
    }
    this.seats.delete(playerId);
    removePlayer(this.game, playerId);
    if (p) this.pushSystem(`${p.name} rời bàn${reason ? ` (${reason})` : ''}.`);
    if (this.hostId === playerId) {
      this.hostId = [...this.seats.keys()].find(
        (id) => !getPlayer(this.game, id)?.isBot,
      ) ?? null;
    }
    // Nếu người rời đang tới lượt thì phải đẩy ván đi tiếp
    if (this.game.phase === PHASE.BETTING && !currentActor(this.game)) {
      this.clearTurnTimer();
    }
  }

  addSpectator(name, ws) {
    const id = makeId('s');
    this.spectators.set(id, { ws, name: sanitizeName(name) });
    return id;
  }

  removeSpectator(id) {
    this.spectators.delete(id);
  }

  /* ---------------------------------------------------------------- */
  /*  BOT                                                              */
  /* ---------------------------------------------------------------- */

  addBot(profile = 'normal') {
    if (this.isFull()) throw new Error('Bàn đã đầy');
    const used = new Set(this.game.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.game.players.length}`;
    const id = makeId('b');
    const p = addPlayer(this.game, { id, name, isBot: true, chips: this.botStack() });
    p.botProfile = profile;
    this.pushSystem(`${name} vào bàn.`);
    return p;
  }

  /** Vốn của bot. Ở bàn công khai phải đủ dày so với mức bàn. */
  botStack() {
    return this.walletMode
      ? this.tier.minBalance * BOT_STACK_MULTIPLIER
      : this.config.startChips;
  }

  removeBot(id) {
    const p = getPlayer(this.game, id);
    if (!p || !p.isBot) throw new Error('Không tìm thấy bot đó');
    if (p.inHand && this.game.phase === PHASE.BETTING) {
      throw new Error('Không thể đuổi bot khi đang giữa ván');
    }
    removePlayer(this.game, id);
    this.pushSystem(`${p.name} rời bàn.`);
  }

  /* ---------------------------------------------------------------- */
  /*  LUỒNG VÁN                                                        */
  /* ---------------------------------------------------------------- */

  canStart() {
    return canStartRound(this.game);
  }

  /**
   * Bàn công khai tự chia ván khi đủ người — không cần ai bấm "Bắt đầu".
   * Phòng riêng thì vẫn để chủ bàn quyết định lúc nào chia.
   */
  maybeAutoStart(delayMs = 2000) {
    if (!this.walletMode || this.closed) return;
    if (!this.config.autoStart) return;
    if (this.nextRoundTimer) return;
    if (this.game.phase === PHASE.BETTING || this.game.phase === PHASE.SHOWDOWN) return;
    if (!this.canStart()) return;
    this.nextRoundTimer = setTimeout(() => {
      this.nextRoundTimer = null;
      if (this.closed) return;
      if (this.canStart()) this.startRound();
    }, delayMs);
  }

  startRound() {
    this.clearTimers();
    const res = startRound(this.game);
    if (!res.ok) return res;
    this.broadcastEvents(res.events);
    this.afterEngineStep();
    return res;
  }

  /** Người chơi tự lật một lá (hoặc cả 3) bài của mình. */
  handleFlip(playerId, which) {
    const res = flipCards(this.game, playerId, which);
    if (!res.ok) return res;
    this.broadcastEvents(res.events);
    this.broadcastState();
    return res;
  }

  handleAction(playerId, action) {
    const res = applyAction(this.game, playerId, action);
    if (!res.ok) return res;
    this.broadcastEvents(res.events);
    this.afterEngineStep();
    return res;
  }

  /**
   * Sau mỗi bước của engine: đặt lại đồng hồ, cho bot đi, hoặc hẹn ván mới.
   */
  afterEngineStep() {
    this.clearTurnTimer();
    clearTimeout(this.botTimer);

    if (this.game.phase === PHASE.BETTING) {
      const actor = currentActor(this.game);
      if (!actor) return;

      if (actor.isBot) {
        this.turnDeadline = null;
        this.broadcastState();
        this.botTimer = setTimeout(() => {
          if (this.closed) return;
          const legal = getLegalActions(this.game);
          if (!legal || legal.playerId !== actor.id) return;
          const action = decideBotAction(actor, legal, {
            ante: this.config.ante,
            random: cryptoRandom,
            profile: actor.botProfile,
          });
          this.handleAction(actor.id, action);
        }, botThinkDelay(cryptoRandom));
        return;
      }

      this.turnDeadline = Date.now() + this.config.turnSeconds * 1000;
      this.broadcastState();
      this.turnTimer = setTimeout(() => {
        if (this.closed) return;
        const res = timeoutAction(this.game);
        if (res.ok) {
          this.broadcastEvents(res.events);
          this.afterEngineStep();
        }
      }, this.config.turnSeconds * 1000 + 400); // +400ms bù độ trễ mạng
      return;
    }

    this.turnDeadline = null;

    if (this.game.phase === PHASE.ROUND_OVER || this.game.phase === PHASE.GAME_OVER) {
      this.recordHistory();
      this.settleWallets();
      this.broadcastState();
      if (this.game.phase === PHASE.ROUND_OVER && this.config.autoStart) {
        this.nextRoundTimer = setTimeout(() => {
          this.nextRoundTimer = null;
          if (this.closed) return;
          if (this.canStart()) this.startRound();
        }, this.config.nextRoundDelaySeconds * 1000);
      } else {
        // settleWallets() có thể đưa bàn công khai từ "tan sòng" về "chờ người"
        this.maybeAutoStart(this.config.nextRoundDelaySeconds * 1000);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  VÍ XU (chỉ bàn công khai)                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Xếp một thao tác ghi CSDL vào hàng đợi của phòng.
   *
   * Ghi vào Postgres là bất đồng bộ, nhưng luồng ván bài thì đồng bộ (chạy từ
   * đồng hồ đếm lượt). Nối các lần ghi thành một chuỗi để chúng luôn xảy ra
   * đúng thứ tự phát sinh — nếu bắn song song, hai lần cập nhật số dư của cùng
   * một người có thể về đích ngược thứ tự và ghi đè lẫn nhau.
   */
  queueWrite(fn) {
    this.writeChain = (this.writeChain ?? Promise.resolve())
      .then(fn)
      .catch((err) => console.error('Lỗi ghi số dư:', err?.message ?? err));
    return this.writeChain;
  }

  /** Chờ mọi thao tác ghi đang xếp hàng hoàn tất. Dùng trong test. */
  flushWrites() {
    return this.writeChain ?? Promise.resolve();
  }

  /** Chép chip trên bàn của một người về số dư tài khoản. */
  syncOneWallet(playerId) {
    if (!this.walletMode) return;
    const accountId = this.accountOf.get(playerId);
    if (!accountId) return;
    const p = getPlayer(this.game, playerId);
    if (!p) return;
    const chips = p.chips;
    this.queueWrite(() => this.store.setBalance(accountId, chips));
  }

  /**
   * Chốt sổ sau mỗi ván ở bàn công khai:
   *  - chép chip trên bàn về ví
   *  - bơm lại vốn cho bot (bot không phải tài khoản thật)
   *  - mời ra ngoài những ai không còn đủ số dư tối thiểu của bàn
   *  - bàn công khai không có "tan sòng", cứ chờ người mới vào
   */
  settleWallets() {
    if (!this.walletMode) return;

    for (const playerId of this.accountOf.keys()) this.syncOneWallet(playerId);

    for (const p of [...this.game.players]) {
      if (p.isBot) {
        p.chips = this.botStack();
        p.eliminated = false;
        continue;
      }
      if (p.chips < this.tier.minBalance) {
        this.removeSeat(
          p.id,
          `Bạn còn ${fmt(p.chips)} xu, không đủ mức tối thiểu ${fmt(this.tier.minBalance)} xu của ${this.tier.label}.`,
        );
      }
    }

    // Người còn ngồi lại vẫn chơi tiếp — bàn công khai không kết thúc.
    if (this.game.phase === PHASE.GAME_OVER) {
      this.game.phase = PHASE.WAITING;
      for (const p of this.game.players) p.eliminated = false;
    }
  }

  /** Bắt đầu lại từ đầu: mọi người về vốn ban đầu. */
  resetGame() {
    this.clearTimers();
    for (const p of this.game.players) {
      p.chips = this.config.startChips;
      p.eliminated = false;
      p.folded = false;
      p.allIn = false;
      p.inHand = false;
      p.hand = [];
      p.reveal = null;
      p.betThisRound = 0;
      p.committed = 0;
      p.stats = { roundsPlayed: 0, roundsWon: 0, chipsWon: 0, chipsLost: 0 };
    }
    this.game.phase = PHASE.WAITING;
    this.game.roundNum = 0;
    this.game.pot = 0;
    this.game.lastResult = null;
    this.history = [];
    this.pushSystem('Ván bài được chia lại từ đầu.');
    this.broadcastState();
  }

  recordHistory() {
    const r = this.game.lastResult;
    if (!r) return;
    if (this.history.some((h) => h.roundNum === r.roundNum)) return;
    const nameOf = (id) => getPlayer(this.game, id)?.name ?? '(đã rời)';
    this.history.unshift({
      roundNum: r.roundNum,
      ts: Date.now(),
      totalPot: r.totalPot,
      winners: r.winnerIds.map((id) => ({ id, name: nameOf(id) })),
      pots: r.pots.map((p) => ({
        amount: p.amount,
        winners: p.winners.map(nameOf),
      })),
      reveals: r.reveals.map((x) => ({
        name: nameOf(x.playerId),
        cards: x.cards,
        label: x.label,
      })),
    });
    if (this.history.length > this.config.historyLimit) {
      this.history.length = this.config.historyLimit;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  CHAT                                                             */
  /* ---------------------------------------------------------------- */

  chat(fromName, text) {
    const clean = String(text ?? '').slice(0, 300).trim();
    if (!clean) return null;
    const msg = { from: fromName, text: clean, ts: Date.now(), system: false };
    this.pushChat(msg);
    return msg;
  }

  pushSystem(text) {
    this.pushChat({ from: null, text, ts: Date.now(), system: true });
  }

  pushChat(msg) {
    this.chatLog.push(msg);
    if (this.chatLog.length > 200) this.chatLog.shift();
    this.broadcast({ t: 'chat', msg });
  }

  /* ---------------------------------------------------------------- */
  /*  GỬI TIN                                                          */
  /* ---------------------------------------------------------------- */

  roomMeta() {
    return {
      code: this.code,
      hostId: this.hostId,
      tier: this.tier
        ? { id: this.tier.id, label: this.tier.label, minBalance: this.tier.minBalance }
        : null,
      walletMode: this.walletMode,
      config: {
        ante: this.config.ante,
        startChips: this.config.startChips,
        maxRaises: this.config.maxRaises,
        maxPlayers: this.config.maxPlayers,
        turnSeconds: this.config.turnSeconds,
        tiebreakBySuit: this.config.tiebreakBySuit,
        autoStart: this.config.autoStart,
      },
      online: Object.fromEntries(
        [...this.seats].map(([id, c]) => [id, c.online]),
      ),
      spectators: [...this.spectators.values()].map((s) => s.name),
      canStart: this.canStart(),
    };
  }

  stateFor(viewerId) {
    return {
      t: 'state',
      room: this.roomMeta(),
      turnDeadline: this.turnDeadline,
      serverTime: Date.now(),
      state: publicView(this.game, viewerId),
      history: this.history.slice(0, 10),
    };
  }

  broadcastState() {
    for (const [id, conn] of this.seats) {
      if (conn.ws) send(conn.ws, this.stateFor(id));
    }
    for (const [, s] of this.spectators) {
      send(s.ws, this.stateFor(null));
    }
  }

  broadcastEvents(events) {
    if (!events?.length) return;
    // Sự kiện showdown chứa bài của mọi người — nhưng chỉ được phát sau khi
    // engine đã quyết định ngửa bài, nên phát nguyên vẹn là an toàn.
    this.broadcast({ t: 'events', events, names: this.nameMap() });
  }

  nameMap() {
    return Object.fromEntries(this.game.players.map((p) => [p.id, p.name]));
  }

  broadcast(msg) {
    for (const [, conn] of this.seats) if (conn.ws) send(conn.ws, msg);
    for (const [, s] of this.spectators) send(s.ws, msg);
  }

  sendTo(playerId, msg) {
    const conn = this.seats.get(playerId);
    if (conn?.ws) send(conn.ws, msg);
  }

  /* ---------------------------------------------------------------- */

  clearTurnTimer() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
  }

  clearTimers() {
    this.clearTurnTimer();
    clearTimeout(this.botTimer);
    clearTimeout(this.nextRoundTimer);
    this.botTimer = null;
    this.nextRoundTimer = null;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    clearTimeout(this.reapTimer);
    this.onEmpty(this);
  }
}

export function send(ws, msg) {
  if (!ws) return;
  if (ws.readyState !== 1) return; // 1 = OPEN
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* kết nối đã hỏng, bỏ qua */
  }
}

export function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[\x00-\x1f<>]/g, '').trim();
  return clean.slice(0, 20) || 'Khách';
}

/* ================================================================== */
/*  QUẢN LÝ NHIỀU PHÒNG                                                */
/* ================================================================== */

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  create(code, config, opts = {}) {
    const room = new Room(code, config, (r) => this.rooms.delete(r.code), opts);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Tài khoản này đang ngồi ở bàn nào không?
   * Một tài khoản chỉ được ngồi một bàn — nếu không thì cùng một số dư sẽ
   * bị đem đi cược ở hai nơi cùng lúc.
   */
  findSeat(accountId) {
    for (const room of this.rooms.values()) {
      for (const [playerId, accId] of room.accountOf) {
        if (accId === accountId) return { room, playerId };
      }
    }
    return null;
  }

  /**
   * Giải phóng ghế cũ của tài khoản trước khi cho ngồi bàn mới.
   * @throws nếu đang giữa ván ở bàn cũ — lúc đó tiền đang nằm trong hũ.
   */
  releaseSeat(accountId) {
    const found = this.findSeat(accountId);
    if (!found) return;
    const { room, playerId } = found;
    const player = getPlayer(room.game, playerId);
    if (player?.inHand && room.game.phase === PHASE.BETTING) {
      throw new Error('Bạn đang chơi dở một ván ở bàn khác, xong ván rồi hãy đổi bàn');
    }
    room.removeSeat(playerId, 'chuyển sang bàn khác');
    room.broadcastState();
  }

  /** Danh sách bàn công khai của một mức, kèm số người đang ngồi. */
  tierRooms(tierId) {
    return [...this.rooms.values()].filter((r) => r.tier?.id === tierId);
  }

  /**
   * Tìm một bàn của mức này còn ghế trống, không có thì mở bàn mới.
   * @param {object} tier
   * @param {object} store
   * @param {() => string} makeCode
   */
  findOrCreateTierRoom(tier, store, makeCode) {
    // Ưu tiên bàn đông người nhất còn ghế, để mọi người dồn vào một bàn
    // thay vì mỗi người ngồi một bàn trống.
    const open = this.tierRooms(tier.id)
      .filter((r) => !r.isFull())
      .sort((a, b) => b.humanCount - a.humanCount)[0];
    if (open) return open;

    let code;
    let guard = 0;
    do { code = makeCode(); } while (this.rooms.get(code) && guard++ < 20);
    const room = this.create(code, tierRoomConfig(tier), { tier, store });
    // Bàn mới luôn có sẵn 2 nhà cái ảo để vào là chơi được ngay
    room.addBot();
    room.addBot();
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase()) ?? null;
  }

  get size() {
    return this.rooms.size;
  }

  /** Dọn phòng bỏ hoang. */
  sweep(maxIdleMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of [...this.rooms]) {
      const empty = room.onlineHumanCount === 0 && room.spectators.size === 0;
      if (empty && now - room.createdAt > maxIdleMs) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }
}
