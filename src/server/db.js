/**
 * Tài khoản, ví xu và điểm danh.
 *
 * Dùng SQLite có sẵn trong Node (`node:sqlite`) — không thêm thư viện nào.
 * Toàn bộ dữ liệu nằm trong một file duy nhất, sao lưu chỉ cần copy file đó.
 *
 * Cần Node 22.5 trở lên.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STARTING_BALANCE = 50_000; // xu tặng khi mở tài khoản
export const CHECKIN_REWARD = 10_000;   // xu mỗi ô điểm danh
export const GAME_TZ = process.env.GAME_TZ ?? 'Asia/Bangkok';

/* ================================================================== */
/*  NGÀY THEO GIỜ VIỆT NAM                                             */
/* ================================================================== */

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GAME_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Ngày hiện tại theo múi giờ của game.
 *
 * Không dùng `new Date().getDay()` của máy chủ: server đặt ở nước ngoài sẽ
 * đổi ngày lệch mất mấy tiếng so với người chơi.
 *
 * @returns {{date:string, dayIndex:number, weekStart:string}}
 *   dayIndex: 0 = thứ 2 … 6 = chủ nhật
 *   weekStart: ngày thứ 2 của tuần chứa ngày đó (YYYY-MM-DD)
 */
export function gameDay(ts = Date.now()) {
  const date = dateFormatter.format(new Date(ts)); // YYYY-MM-DD
  const utc = new Date(`${date}T00:00:00Z`);
  const dayIndex = (utc.getUTCDay() + 6) % 7; // JS: 0=CN → ta muốn 0=T2
  const monday = new Date(utc.getTime() - dayIndex * 86_400_000);
  return { date, dayIndex, weekStart: monday.toISOString().slice(0, 10) };
}

export const WEEKDAY_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/* ================================================================== */
/*  MẬT KHẨU                                                           */
/* ================================================================== */

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* ================================================================== */

export class Store {
  /** @param {string} file  đường dẫn file SQLite, ':memory:' cho test */
  constructor(file = process.env.DB_FILE ?? 'lieng.db') {
    // Trên Render, DB_FILE trỏ vào ổ đĩa lưu trữ (ví dụ /data/lieng.db).
    // Thư mục chưa có thì SQLite chỉ báo "unable to open database file",
    // rất khó đoán nguyên nhân — nên tự tạo thư mục cho chắc.
    if (file !== ':memory:') {
      try { mkdirSync(dirname(file), { recursive: true }); } catch {}
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT NOT NULL UNIQUE,
        salt         TEXT NOT NULL,
        pass_hash    TEXT NOT NULL,
        display_name TEXT NOT NULL,
        balance      INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkins (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        week_start TEXT NOT NULL,
        day_index  INTEGER NOT NULL,
        amount     INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, week_start, day_index)
      );

      CREATE TABLE IF NOT EXISTS admin_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        username      TEXT NOT NULL,
        delta         INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      );
    `);
  }

  close() {
    try { this.db.close(); } catch {}
  }

  /* ---------------- TÀI KHOẢN ---------------- */

  /**
   * @throws nếu tên đăng nhập đã tồn tại hoặc không hợp lệ
   */
  register(username, password, displayName) {
    const user = normalizeUsername(username);
    if (user.length < 3) throw new Error('Tên đăng nhập phải từ 3 ký tự');
    if (user.length > 20) throw new Error('Tên đăng nhập tối đa 20 ký tự');
    if (!/^[a-z0-9_]+$/.test(user)) {
      throw new Error('Tên đăng nhập chỉ gồm chữ thường, số và dấu gạch dưới');
    }
    if (String(password ?? '').length < 6) {
      throw new Error('Mật khẩu phải từ 6 ký tự');
    }
    if (this.findByUsername(user)) throw new Error('Tên đăng nhập đã có người dùng');

    const { salt, hash } = hashPassword(password);
    const name = cleanDisplayName(displayName || username);
    const info = this.db
      .prepare(
        `INSERT INTO accounts (username, salt, pass_hash, display_name, balance, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(user, salt, hash, name, STARTING_BALANCE, Date.now());
    return this.getAccount(Number(info.lastInsertRowid));
  }

  login(username, password) {
    const row = this.findByUsername(normalizeUsername(username));
    if (!row) throw new Error('Sai tên đăng nhập hoặc mật khẩu');
    if (!verifyPassword(String(password ?? ''), row.salt, row.pass_hash)) {
      throw new Error('Sai tên đăng nhập hoặc mật khẩu');
    }
    return this.getAccount(row.id);
  }

  findByUsername(username) {
    return this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username) ?? null;
  }

  /** Thông tin công khai của tài khoản (không kèm mật khẩu). */
  getAccount(id) {
    const row = this.db
      .prepare('SELECT id, username, display_name, balance, created_at FROM accounts WHERE id = ?')
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      balance: row.balance,
      createdAt: row.created_at,
    };
  }

  getBalance(id) {
    const row = this.db.prepare('SELECT balance FROM accounts WHERE id = ?').get(id);
    return row ? row.balance : null;
  }

  /**
   * Đặt lại số dư về một con số cụ thể.
   * Dùng khi đồng bộ chip trên bàn về ví — engine là nguồn sự thật của ván,
   * ví chỉ chép lại kết quả.
   */
  setBalance(id, balance) {
    if (!Number.isInteger(balance) || balance < 0) {
      throw new Error(`Số dư không hợp lệ: ${balance}`);
    }
    this.db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(balance, id);
    return balance;
  }

  /** Cộng/trừ số dư. Trả về số dư mới. Không cho âm. */
  addBalance(id, delta) {
    const current = this.getBalance(id);
    if (current === null) throw new Error('Không tìm thấy tài khoản');
    const next = current + delta;
    if (next < 0) throw new Error('Số dư không đủ');
    return this.setBalance(id, next);
  }

  renameAccount(id, displayName) {
    const name = cleanDisplayName(displayName);
    this.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(name, id);
    return name;
  }

  /* ---------------- PHIÊN ĐĂNG NHẬP ---------------- */

  createSession(accountId) {
    const token = randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)')
      .run(token, accountId, Date.now());
    return token;
  }

  /** Trả về tài khoản của phiên, hoặc null nếu token sai/hết hạn. */
  resolveSession(token, maxAgeMs = 30 * 24 * 3600 * 1000) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (Date.now() - row.created_at > maxAgeMs) {
      this.destroySession(token);
      return null;
    }
    return this.getAccount(row.account_id);
  }

  destroySession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /* ---------------- ĐIỂM DANH ---------------- */

  /**
   * Thẻ điểm danh của tuần hiện tại: 7 ô từ thứ 2 tới chủ nhật.
   * Ô đã nhận thì `claimed = true`; ô của ngày mai trở đi thì `future = true`.
   */
  getCheckinCard(accountId, ts = Date.now()) {
    const { weekStart, dayIndex, date } = gameDay(ts);
    const rows = this.db
      .prepare('SELECT day_index, amount FROM checkins WHERE account_id = ? AND week_start = ?')
      .all(accountId, weekStart);
    const claimed = new Map(rows.map((r) => [r.day_index, r.amount]));

    const days = WEEKDAY_LABELS.map((label, i) => ({
      dayIndex: i,
      label,
      reward: CHECKIN_REWARD,
      claimed: claimed.has(i),
      amount: claimed.get(i) ?? 0,
      today: i === dayIndex,
      future: i > dayIndex,
      missed: i < dayIndex && !claimed.has(i),
    }));

    return {
      weekStart,
      today: date,
      todayIndex: dayIndex,
      canClaimToday: !claimed.has(dayIndex),
      claimedThisWeek: rows.length,
      totalThisWeek: rows.reduce((s, r) => s + r.amount, 0),
      days,
    };
  }

  /**
   * Nhận thưởng điểm danh của HÔM NAY.
   * Chỉ nhận được ô của ngày hôm nay — bỏ ngày nào là mất ngày đó.
   *
   * @returns {{ok:true, amount:number, balance:number, card:object}}
   * @throws nếu hôm nay đã điểm danh rồi
   */
  claimCheckin(accountId, ts = Date.now()) {
    const { weekStart, dayIndex } = gameDay(ts);
    const already = this.db
      .prepare(
        'SELECT 1 FROM checkins WHERE account_id = ? AND week_start = ? AND day_index = ?',
      )
      .get(accountId, weekStart, dayIndex);
    if (already) throw new Error('Hôm nay bạn đã điểm danh rồi');

    // Ghi nhận trước rồi mới cộng xu: khoá UNIQUE của bảng đảm bảo hai yêu cầu
    // gửi cùng lúc thì chỉ một cái ghi được, không thể nhận thưởng hai lần.
    this.db
      .prepare(
        `INSERT INTO checkins (account_id, week_start, day_index, amount, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountId, weekStart, dayIndex, CHECKIN_REWARD, ts);

    const balance = this.addBalance(accountId, CHECKIN_REWARD);
    return {
      ok: true,
      amount: CHECKIN_REWARD,
      balance,
      card: this.getCheckinCard(accountId, ts),
    };
  }

  /* ---------------- TRANG QUẢN LÝ ---------------- */

  /**
   * Cộng (hoặc trừ, khi delta âm) xu cho một tài khoản theo TÊN ĐĂNG NHẬP,
   * đồng thời ghi vào sổ cái.
   *
   * @returns {{account:object, delta:number, balanceBefore:number, balanceAfter:number}}
   */
  adminAdjust(username, delta, reason = '', ts = Date.now()) {
    const row = this.findByUsername(normalizeUsername(username));
    if (!row) throw new Error(`Không có tài khoản nào tên "${username}"`);
    const amount = Math.trunc(Number(delta));
    if (!Number.isFinite(amount) || amount === 0) {
      throw new Error('Số xu phải là số nguyên khác 0');
    }
    const balanceBefore = row.balance;
    if (balanceBefore + amount < 0) {
      throw new Error(
        `Trừ ${Math.abs(amount).toLocaleString('vi-VN')} xu thì âm mất — tài khoản chỉ có ${balanceBefore.toLocaleString('vi-VN')} xu`,
      );
    }
    const balanceAfter = this.setBalance(row.id, balanceBefore + amount);
    this.writeAdminLog(row.id, row.username, amount, balanceAfter, reason, ts);
    return { account: this.getAccount(row.id), delta: amount, balanceBefore, balanceAfter };
  }

  /** Đặt thẳng số dư về một con số. Sổ cái ghi lại phần chênh lệch. */
  adminSetBalance(username, value, reason = '', ts = Date.now()) {
    const row = this.findByUsername(normalizeUsername(username));
    if (!row) throw new Error(`Không có tài khoản nào tên "${username}"`);
    const target = Math.trunc(Number(value));
    if (!Number.isInteger(target) || target < 0) {
      throw new Error('Số dư mới phải là số nguyên không âm');
    }
    const balanceBefore = row.balance;
    const balanceAfter = this.setBalance(row.id, target);
    const delta = balanceAfter - balanceBefore;
    if (delta !== 0) {
      this.writeAdminLog(row.id, row.username, delta, balanceAfter, reason, ts);
    }
    return { account: this.getAccount(row.id), delta, balanceBefore, balanceAfter };
  }

  writeAdminLog(accountId, username, delta, balanceAfter, reason, ts) {
    this.db
      .prepare(
        `INSERT INTO admin_log (account_id, username, delta, balance_after, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, username, delta, balanceAfter, String(reason ?? '').slice(0, 200), ts);
  }

  /** 20 giao dịch gần nhất, mới nhất lên đầu. */
  adminLog(limit = 20) {
    return this.db
      .prepare(
        `SELECT username, delta, balance_after, reason, created_at
         FROM admin_log ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, limit)))
      .map((r) => ({
        username: r.username,
        delta: r.delta,
        balanceAfter: r.balance_after,
        reason: r.reason,
        at: r.created_at,
      }));
  }

  /** Danh sách tài khoản cho trang quản lý, có tìm kiếm theo tên. */
  listAccounts({ q = '', limit = 50 } = {}) {
    const n = Math.max(1, Math.min(200, limit));
    const term = String(q ?? '').trim().toLowerCase();
    const rows = term
      ? this.db
          .prepare(
            `SELECT id, username, display_name, balance, created_at FROM accounts
             WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?
             ORDER BY balance DESC LIMIT ?`,
          )
          .all(`%${term}%`, `%${term}%`, n)
      : this.db
          .prepare(
            `SELECT id, username, display_name, balance, created_at FROM accounts
             ORDER BY balance DESC LIMIT ?`,
          )
          .all(n);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      balance: r.balance,
      createdAt: r.created_at,
    }));
  }

  countAccounts() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  }

  /* ---------------- THỐNG KÊ ---------------- */

  /** Tổng xu toàn hệ thống — dùng để kiểm tra không có xu tự sinh ra. */
  totalBalance() {
    return this.db.prepare('SELECT COALESCE(SUM(balance),0) AS s FROM accounts').get().s;
  }

  topPlayers(limit = 10) {
    return this.db
      .prepare('SELECT display_name, balance FROM accounts ORDER BY balance DESC LIMIT ?')
      .all(limit);
  }
}

function normalizeUsername(username) {
  return String(username ?? '').trim().toLowerCase();
}

function cleanDisplayName(name) {
  const clean = String(name ?? '').replace(/[\x00-\x1f<>]/g, '').trim();
  return clean.slice(0, 20) || 'Khách';
}
