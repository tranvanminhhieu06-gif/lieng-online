/**
 * Máy chủ Liêng online.
 *
 *  - phục vụ file tĩnh trong public/
 *  - nhận WebSocket ở /ws
 *  - mọi luật chơi chạy ở đây, client chỉ vẽ và gửi ý định
 *
 * Hai loại bàn:
 *  - Bàn công khai theo mức (1K/5K/20K/100K): chip trên bàn chính là số dư
 *    tài khoản, phải đủ số dư tối thiểu mới vào được.
 *  - Phòng riêng theo mã mời: chip vui, không đụng tới ví.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomManager, send, ROOM_DEFAULTS } from './room.js';
import { makeRoomCode } from './rng.js';
import { Store, STARTING_BALANCE, CHECKIN_REWARD } from './db.js';
import { TIERS, getTier } from './tiers.js';
import { handleAdminApi, ADMIN_ENABLED } from './admin.js';
import { getPlayer, PHASE } from '../engine/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Tự động nạp cấu hình từ .env nếu chưa được thiết lập qua biến môi trường
try {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

// DB_SCHEMA cho phép nhiều môi trường dùng chung một Postgres (test dùng nó
// để mỗi file test có schema riêng). Không đặt thì dùng schema mặc định.
//
// Nếu không kết nối được thì in một thông báo ngắn gọn rồi thoát, thay vì để
// driver đổ ra một object lỗi bốn chục dòng toàn `undefined`.
let store;
try {
  store = await new Store(process.env.DATABASE_URL, {
    schema: process.env.DB_SCHEMA,
  }).init();
} catch (err) {
  console.error('\n================ KHÔNG KHỞI ĐỘNG ĐƯỢC ================');
  console.error(err.message);
  console.error('======================================================\n');
  process.exit(1);
}
const rooms = new RoomManager();
setInterval(() => rooms.sweep(), 10 * 60 * 1000).unref?.();

/* ================================================================== */
/*  HTTP TĨNH                                                          */
/* ================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }

  if (handleAdminApi(req, res, url, { store, rooms })) return;

  // Trang quản lý chỉ tồn tại khi máy chủ có đặt ADMIN_PASSWORD
  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    if (!ADMIN_ENABLED) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Không tìm thấy trang');
      return;
    }
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    return;
  }

  // Vào bằng link mời /r/ABC123 thì vẫn trả về trang chính
  let rel = url.pathname === '/' || url.pathname.startsWith('/r/')
    ? 'index.html'
    : url.pathname.replace(/^\/+/, '');

  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  serveFile(res, filePath);
});

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Không tìm thấy trang');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* ================================================================== */
/*  WEBSOCKET                                                          */
/* ================================================================== */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  const session = {
    account: null,      // { id, username, displayName, balance }
    room: null,
    playerId: null,
    spectatorId: null,
  };

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 1000);

  // Xử lý tin nhắn phải chờ CSDL, nên nối chúng thành một chuỗi: gói tin sau
  // chỉ chạy khi gói trước xong. Nếu để chạy chồng nhau thì client gửi liền
  // `auth` rồi `join-tier` sẽ bị báo "cần đăng nhập" — vì lệnh thứ hai bắt đầu
  // trước khi lệnh đăng nhập kịp gán phiên.
  let chuoiXuLy = Promise.resolve();

  ws.on('message', (raw) => {
    if (++msgCount > 25) {
      send(ws, { t: 'error', message: 'Gửi quá nhanh, chậm lại giúp mình.' });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: 'Gói tin không hợp lệ' });
      return;
    }
    chuoiXuLy = chuoiXuLy
      .then(() => handleMessage(ws, session, msg))
      .catch((err) => {
        send(ws, { t: 'error', message: err?.message ?? 'Có lỗi xảy ra' });
      });
  });

  ws.on('close', () => {
    clearInterval(rateTimer);
    const { room, playerId, spectatorId } = session;
    if (!room) return;
    if (playerId) {
      room.detach(playerId);
      room.broadcastState();
    }
    if (spectatorId) {
      room.removeSpectator(spectatorId);
      room.broadcastState();
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
heartbeat.unref?.();

/* ------------------------------------------------------------------ */

async function handleMessage(ws, session, msg) {
  switch (msg.t) {
    case 'ping':
      send(ws, { t: 'pong', ts: Date.now() });
      return;

    /* ------------- TÀI KHOẢN ------------- */

    case 'register': {
      const account = await store.register(msg.username, msg.password, msg.displayName);
      await finishAuth(ws, session, account);
      return;
    }

    case 'login': {
      const account = await store.login(msg.username, msg.password);
      await finishAuth(ws, session, account);
      return;
    }

    case 'auth': {
      const account = await store.resolveSession(msg.sessionToken);
      if (!account) throw new Error('Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');
      session.account = account;
      send(ws, {
        t: 'auth-ok',
        account,
        checkin: await store.getCheckinCard(account.id),
      });
      await sendLobby(ws, session);
      return;
    }

    case 'logout': {
      if (msg.sessionToken) await store.destroySession(msg.sessionToken);
      leaveCurrent(session);
      session.account = null;
      send(ws, { t: 'logged-out' });
      return;
    }

    /* ------------- ĐIỂM DANH ------------- */

    case 'checkin': {
      const account = requireAuth(session);
      const res = await store.claimCheckin(account.id);
      session.account = await store.getAccount(account.id);
      send(ws, {
        t: 'checkin-result',
        amount: res.amount,
        balance: res.balance,
        card: res.card,
        account: session.account,
      });
      await sendLobby(ws, session);
      return;
    }

    /* ------------- SẢNH ------------- */

    case 'lobby': {
      requireAuth(session);
      await sendLobby(ws, session);
      return;
    }

    case 'join-tier': {
      const account = await refreshAccount(session);
      const tier = getTier(msg.tierId);
      if (!tier) throw new Error('Không có mức bàn đó');
      if (account.balance < tier.minBalance) {
        throw new Error(
          `${tier.label} cần tối thiểu ${fmt(tier.minBalance)} xu, bạn đang có ${fmt(account.balance)} xu`,
        );
      }

      rooms.releaseSeat(account.id); // không cho ngồi hai bàn cùng lúc
      leaveCurrent(session);

      const room = rooms.findOrCreateTierRoom(tier, store, makeRoomCode);
      const { playerId, token } = room.joinAsPlayer(account.displayName, account);
      room.attach(playerId, ws);
      session.room = room;
      session.playerId = playerId;

      send(ws, {
        t: 'joined',
        code: room.code,
        playerId,
        token,
        isHost: room.hostId === playerId,
        tier: { id: tier.id, label: tier.label, minBalance: tier.minBalance },
      });
      send(ws, { t: 'chat-history', msgs: room.chatLog.slice(-50) });
      room.pushSystem(`${account.displayName} vào bàn.`);
      room.broadcastState();
      room.maybeAutoStart();
      return;
    }

    /* ------------- PHÒNG RIÊNG ------------- */

    case 'create': {
      const account = requireAuth(session);
      rooms.releaseSeat(account.id);
      leaveCurrent(session);

      const config = sanitizeConfig(msg.config);
      let code;
      let guard = 0;
      do { code = makeRoomCode(); } while (rooms.get(code) && guard++ < 20);
      const room = rooms.create(code, config);
      const { playerId, token } = room.joinAsPlayer(account.displayName);
      room.attach(playerId, ws);
      session.room = room;
      session.playerId = playerId;

      const bots = Math.max(0, Math.min(Number(msg.bots ?? 0), room.config.maxPlayers - 1));
      for (let i = 0; i < bots; i++) room.addBot();

      send(ws, { t: 'joined', code, playerId, token, isHost: true, tier: null });
      room.pushSystem(`${account.displayName} tạo bàn. Mã phòng: ${code}`);
      room.broadcastState();
      return;
    }

    case 'join': {
      const account = requireAuth(session);
      const room = rooms.get(msg.code);
      if (!room) throw new Error('Không tìm thấy phòng với mã đó');
      if (room.tier) throw new Error('Bàn công khai phải vào từ sảnh');

      rooms.releaseSeat(account.id);
      leaveCurrent(session);

      if (msg.spectate || room.isFull()) {
        const spectatorId = room.addSpectator(account.displayName, ws);
        session.room = room;
        session.spectatorId = spectatorId;
        send(ws, {
          t: 'joined',
          code: room.code,
          spectatorId,
          spectating: true,
          reason: room.isFull() && !msg.spectate ? 'Bàn đã đầy, bạn đang xem.' : null,
        });
        send(ws, { t: 'chat-history', msgs: room.chatLog.slice(-50) });
        room.broadcastState();
        return;
      }

      const { playerId, token } = room.joinAsPlayer(account.displayName);
      room.attach(playerId, ws);
      session.room = room;
      session.playerId = playerId;
      send(ws, { t: 'joined', code: room.code, playerId, token, isHost: room.hostId === playerId, tier: null });
      send(ws, { t: 'chat-history', msgs: room.chatLog.slice(-50) });
      room.pushSystem(`${account.displayName} vào bàn.`);
      room.broadcastState();
      return;
    }

    case 'resume': {
      requireAuth(session);
      const room = rooms.get(msg.code);
      if (!room) throw new Error('Phòng không còn tồn tại');
      const playerId = room.resume(msg.token, ws);
      if (!playerId) throw new Error('Không nhận lại được ghế, hãy vào lại từ sảnh');
      session.room = room;
      session.playerId = playerId;
      send(ws, {
        t: 'joined',
        code: room.code,
        playerId,
        token: msg.token,
        isHost: room.hostId === playerId,
        tier: room.tier
          ? { id: room.tier.id, label: room.tier.label, minBalance: room.tier.minBalance }
          : null,
        resumed: true,
      });
      send(ws, { t: 'chat-history', msgs: room.chatLog.slice(-50) });
      room.broadcastState();
      return;
    }

    /* ------------- TRONG BÀN ------------- */

    case 'start': {
      const { room, playerId } = requirePlayer(session);
      if (room.hostId !== playerId) throw new Error('Chỉ chủ bàn mới bắt đầu được');
      if (room.game.phase === PHASE.BETTING) throw new Error('Ván đang diễn ra');
      const res = room.startRound();
      if (!res.ok) throw new Error(res.error);
      return;
    }

    case 'flip': {
      const { room, playerId } = requirePlayer(session);
      const res = room.handleFlip(playerId, msg.all ? 'all' : msg.index);
      if (!res.ok) send(ws, { t: 'error', message: res.error });
      return;
    }

    case 'action': {
      const { room, playerId } = requirePlayer(session);
      const res = room.handleAction(playerId, {
        type: msg.action,
        amount: msg.amount,
        actionSeq: msg.actionSeq,
      });
      if (!res.ok) {
        send(ws, { t: 'error', message: res.error });
        send(ws, room.stateFor(playerId));
      } else if (session.account && (room.game.phase === PHASE.ROUND_OVER || room.game.phase === PHASE.GAME_OVER)) {
        await room.flushWrites();
        session.account = await store.getAccount(session.account.id) ?? session.account;
        send(ws, { t: 'account', account: session.account });
      }
      return;
    }

    case 'chat': {
      const { room } = requireRoom(session);
      room.chat(session.account?.displayName ?? 'Khách', msg.text);
      return;
    }

    case 'add-bot': {
      const { room, playerId } = requirePlayer(session);
      if (room.hostId !== playerId) throw new Error('Chỉ chủ bàn mới thêm bot được');
      room.addBot(msg.profile);
      room.broadcastState();
      return;
    }

    case 'remove-bot': {
      const { room, playerId } = requirePlayer(session);
      if (room.hostId !== playerId) throw new Error('Chỉ chủ bàn mới đuổi bot được');
      room.removeBot(msg.id);
      room.broadcastState();
      return;
    }

    case 'reset': {
      const { room, playerId } = requirePlayer(session);
      if (room.hostId !== playerId) throw new Error('Chỉ chủ bàn mới chia lại được');
      if (room.walletMode) throw new Error('Bàn công khai không chia lại vốn được');
      room.resetGame();
      return;
    }

    case 'leave': {
      const phongVuaRoi = session.room;
      const chotSo = phongVuaRoi?.cashOutInfo(session.playerId) ?? null;
      leaveCurrent(session);
      if (session.account) {
        if (phongVuaRoi) await phongVuaRoi.flushWrites();
        session.account = await store.getAccount(session.account.id) ?? session.account;
        send(ws, { t: 'left', cashOut: chotSo, account: session.account });
        send(ws, { t: 'account', account: session.account });
        await sendLobby(ws, session);
      } else {
        send(ws, { t: 'left', cashOut: chotSo });
      }
      return;
    }

    default:
      send(ws, { t: 'error', message: `Không hiểu lệnh: ${msg.t}` });
  }
}

/* ------------------------------------------------------------------ */

async function finishAuth(ws, session, account) {
  session.account = account;
  const sessionToken = await store.createSession(account.id);
  send(ws, {
    t: 'auth-ok',
    account,
    sessionToken,
    checkin: await store.getCheckinCard(account.id),
  });
  await sendLobby(ws, session);
}

/** Sảnh: số dư, thẻ điểm danh, và các mức bàn kèm trạng thái vào được hay không. */
async function sendLobby(ws, session) {
  const account = await refreshAccount(session);
  send(ws, {
    t: 'lobby',
    account,
    checkin: await store.getCheckinCard(account.id),
    startingBalance: STARTING_BALANCE,
    checkinReward: CHECKIN_REWARD,
    tiers: TIERS.map((tier) => {
      const list = rooms.tierRooms(tier.id);
      return {
        id: tier.id,
        label: tier.label,
        ante: tier.ante,
        minBalance: tier.minBalance,
        tables: list.length,
        playersOnline: list.reduce((s, r) => s + r.humanCount, 0),
        canAfford: account.balance >= tier.minBalance,
        shortBy: Math.max(0, tier.minBalance - account.balance),
      };
    }),
  });
}

function requireAuth(session) {
  if (!session.account) throw new Error('Bạn cần đăng nhập trước');
  return session.account;
}

/** Đọc lại số dư từ CSDL — bản trong bộ nhớ có thể đã cũ sau một ván. */
async function refreshAccount(session) {
  const account = requireAuth(session);
  session.account = await store.getAccount(account.id) ?? account;
  return session.account;
}

function requireRoom(session) {
  if (!session.room) throw new Error('Bạn chưa ở trong phòng nào');
  return session;
}

function requirePlayer(session) {
  requireRoom(session);
  if (!session.playerId) throw new Error('Bạn đang xem, không phải người chơi');
  return session;
}

function leaveCurrent(session) {
  const { room, playerId, spectatorId } = session;
  if (!room) return;
  if (playerId) {
    room.removeSeat(playerId, 'tự rời bàn', { notify: false });
    room.broadcastState();
  }
  if (spectatorId) {
    room.removeSpectator(spectatorId);
    room.broadcastState();
  }
  session.room = null;
  session.playerId = null;
  session.spectatorId = null;
}

function sanitizeConfig(config = {}) {
  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  return {
    ante: clamp(config.ante, 1, 1000, ROOM_DEFAULTS.ante),
    startChips: clamp(config.startChips, 20, 1_000_000, ROOM_DEFAULTS.startChips),
    maxRaises: clamp(config.maxRaises, 1, 20, ROOM_DEFAULTS.maxRaises),
    maxPlayers: clamp(config.maxPlayers, 2, 10, ROOM_DEFAULTS.maxPlayers),
    turnSeconds: clamp(config.turnSeconds, 8, 120, ROOM_DEFAULTS.turnSeconds),
    tiebreakBySuit: config.tiebreakBySuit !== false,
    autoStart: config.autoStart !== false,
  };
}

const fmt = (n) => Number(n).toLocaleString('vi-VN');

/* ================================================================== */

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`Liêng online đang chạy tại http://localhost:${PORT}`);
  });
}

export { server, wss, rooms, store };
