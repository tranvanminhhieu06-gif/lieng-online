/**
 * Trang quản lý — cộng/trừ xu cho người chơi theo tên đăng nhập.
 *
 * BẢO MẬT: trang này in ra tiền, nên mặc định TẮT HẲN.
 * Chỉ bật khi chạy server có biến môi trường ADMIN_PASSWORD:
 *
 *     ADMIN_PASSWORD='mat-khau-that-dai' npm start
 *
 * Không đặt biến đó thì mọi đường dẫn /admin trả về 404 y như không tồn tại.
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { getPlayer } from '../engine/game.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
export const ADMIN_ENABLED = ADMIN_PASSWORD.length > 0;

const TOKEN_TTL_MS = 8 * 3600 * 1000;
/** @type {Map<string, number>} token -> hạn dùng */
const tokens = new Map();

/** Chống dò mật khẩu: khoá tạm sau nhiều lần sai. */
const failures = { count: 0, until: 0 };
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

function checkPassword(input) {
  const a = createHash('sha256').update(String(input ?? '')).digest();
  const b = createHash('sha256').update(ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function issueToken() {
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function validToken(token) {
  const expiry = tokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { tokens.delete(token); return false; }
  return true;
}

/* ================================================================== */

/**
 * Xử lý các đường dẫn /admin/api/*.
 *
 * @returns {boolean} true nếu đã xử lý xong (đã trả lời), false nếu không phải
 *   việc của module này.
 */
export function handleAdminApi(req, res, url, { store, rooms }) {
  if (!url.pathname.startsWith('/admin/api/')) return false;
  if (!ADMIN_ENABLED) {
    json(res, 404, { error: 'Trang quản lý chưa được bật trên máy chủ này' });
    return true;
  }

  const route = url.pathname.slice('/admin/api/'.length);

  if (route === 'login' && req.method === 'POST') {
    readJson(req, res, (body) => {
      if (Date.now() < failures.until) {
        json(res, 429, { error: 'Sai quá nhiều lần, thử lại sau 5 phút' });
        return;
      }
      if (!checkPassword(body.password)) {
        failures.count += 1;
        if (failures.count >= MAX_FAILURES) {
          failures.until = Date.now() + LOCKOUT_MS;
          failures.count = 0;
        }
        json(res, 401, { error: 'Sai mật khẩu quản lý' });
        return;
      }
      failures.count = 0;
      json(res, 200, { token: issueToken() });
    });
    return true;
  }

  // Từ đây trở xuống bắt buộc phải có token hợp lệ
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!validToken(token)) {
    json(res, 401, { error: 'Phiên quản lý đã hết hạn, hãy đăng nhập lại' });
    return true;
  }

  if (route === 'players' && req.method === 'GET') {
    json(res, 200, {
      total: store.countAccounts(),
      players: store.listAccounts({ q: url.searchParams.get('q') ?? '', limit: 50 }),
    });
    return true;
  }

  if (route === 'log' && req.method === 'GET') {
    json(res, 200, { log: store.adminLog(20) });
    return true;
  }

  if (route === 'adjust' && req.method === 'POST') {
    readJson(req, res, (body) => {
      try {
        json(res, 200, applyAdjustment(body, { store, rooms }));
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return true;
  }

  json(res, 404, { error: 'Không có API đó' });
  return true;
}

/**
 * Cộng/trừ xu, và nếu người đó đang ngồi ở bàn công khai thì sửa luôn chip
 * trên bàn.
 *
 * Vì sao phải làm vậy: ở bàn công khai, sau mỗi ván server GHI ĐÈ số dư bằng
 * số chip trên bàn. Nếu chỉ sửa trong CSDL, xu vừa cộng sẽ bị xoá sạch khi ván
 * đang chơi kết thúc.
 */
export function applyAdjustment({ username, mode, amount, reason }, { store, rooms }) {
  const name = String(username ?? '').trim();
  if (!name) throw new Error('Chưa điền tên đăng nhập');

  const account = store.findByUsername(name.toLowerCase());
  if (!account) throw new Error(`Không có tài khoản nào tên "${name}"`);

  const seat = rooms.findSeat(account.id);

  if (mode === 'set') {
    if (seat) {
      throw new Error(
        `${name} đang ngồi ở bàn ${seat.room.tier?.label ?? seat.room.code}. ` +
        'Đặt lại số dư lúc này sẽ lệch với chip trên bàn — hãy dùng cộng/trừ, ' +
        'hoặc đợi họ rời bàn.',
      );
    }
    const res = store.adminSetBalance(name, amount, reason);
    return { ...res, seated: null };
  }

  const res = store.adminAdjust(name, amount, reason);

  if (seat) {
    const player = getPlayer(seat.room.game, seat.playerId);
    if (player) {
      player.chips = Math.max(0, player.chips + res.delta);
      seat.room.broadcastState();
      seat.room.pushSystem(
        res.delta > 0
          ? `${player.name} được cộng ${fmt(res.delta)} xu.`
          : `${player.name} bị trừ ${fmt(-res.delta)} xu.`,
      );
    }
  }

  return {
    ...res,
    seated: seat ? (seat.room.tier?.label ?? seat.room.code) : null,
  };
}

/* ------------------------------------------------------------------ */

const fmt = (n) => Number(n).toLocaleString('vi-VN');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req, res, done) {
  let raw = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > 8192) {
      tooBig = true;
      json(res, 413, { error: 'Dữ liệu gửi lên quá lớn' });
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    try {
      done(raw ? JSON.parse(raw) : {});
    } catch {
      json(res, 400, { error: 'Dữ liệu gửi lên không hợp lệ' });
    }
  });
}
