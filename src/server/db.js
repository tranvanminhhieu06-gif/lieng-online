/**
 * Tài khoản, ví xu và điểm danh — lưu trên PostgreSQL.
 *
 * Vì sao không dùng SQLite nữa: gói miễn phí của Render không gắn được ổ đĩa
 * lưu trữ và ngủ đông sau 15 phút, khi dậy thì container dựng lại từ đầu nên
 * file SQLite biến mất. Đặt cơ sở dữ liệu ra ngoài (Neon) thì dữ liệu sống độc
 * lập với vòng đời của server.
 *
 * Toàn bộ hàm ở đây đều bất đồng bộ — Postgres nói chuyện qua mạng.
 */

import pg from 'pg';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

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
  /**
   * @param {string} connectionString  chuỗi kết nối Postgres (DATABASE_URL)
   * @param {{schema?: string}} opts   schema riêng — dùng để test song song
   */
  constructor(connectionString = process.env.DATABASE_URL, opts = {}) {
    if (!connectionString) {
      throw new Error(
        'Thiếu DATABASE_URL. Đặt biến môi trường trỏ tới Postgres, ví dụ Neon.',
      );
    }
    this.schema = opts.schema ?? 'public';
    this.pool = new Pool({
      connectionString,
      // Neon và hầu hết Postgres đám mây bắt buộc TLS.
      ssl: isLocal(connectionString) ? undefined : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      options: this.schema === 'public' ? undefined : `-c search_path=${this.schema}`,
    });
  }

  /**
   * Tạo bảng nếu chưa có. Phải gọi một lần lúc khởi động.
   *
   * Có thử lại vài lần: Neon cho compute ngủ sau ít phút không dùng, lần kết
   * nối đầu tiên là lần đánh thức nó dậy nên hay chậm hoặc lỗi. Nếu để lỗi
   * ngay lần đầu thì cả dịch vụ chết, Render chỉ báo "no open ports detected"
   * — không nói gì về nguyên nhân thật.
   */
  async init({ retries = 5, delayMs = 2000 } = {}) {
    let loiCuoi;
    for (let lan = 1; lan <= retries; lan++) {
      try {
        await this.pool.query('SELECT 1');
        await this.createTables();
        if (lan > 1) console.log(`[CSDL] Kết nối được ở lần thử thứ ${lan}.`);
        return this;
      } catch (err) {
        loiCuoi = err;
        console.error(`[CSDL] Lần thử ${lan}/${retries} thất bại: ${moTaLoi(err)}`);
        if (lan < retries) await new Promise((r) => setTimeout(r, delayMs * lan));
      }
    }
    throw new Error(
      `Không kết nối được cơ sở dữ liệu sau ${retries} lần thử.\n` +
      `Lý do: ${moTaLoi(loiCuoi)}\n` +
      `Gợi ý: ${goiYSua(loiCuoi)}`,
    );
  }

  async createTables() {
    if (this.schema !== 'public') {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id           BIGSERIAL PRIMARY KEY,
        username     TEXT NOT NULL UNIQUE,
        salt         TEXT NOT NULL,
        pass_hash    TEXT NOT NULL,
        display_name TEXT NOT NULL,
        balance      BIGINT NOT NULL DEFAULT 0,
        created_at   BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkins (
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        week_start TEXT NOT NULL,
        day_index  INTEGER NOT NULL,
        amount     BIGINT NOT NULL,
        claimed_at BIGINT NOT NULL,
        PRIMARY KEY (account_id, week_start, day_index)
      );

      CREATE TABLE IF NOT EXISTS admin_log (
        id            BIGSERIAL PRIMARY KEY,
        account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        username      TEXT NOT NULL,
        delta         BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        reason        TEXT NOT NULL DEFAULT '',
        created_at    BIGINT NOT NULL
      );
    `);
    return this;
  }

  async close() {
    try { await this.pool.end(); } catch {}
  }

  /** Chạy một câu lệnh, trả về mảng dòng. */
  async q(sql, params = []) {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  /** Chạy một câu lệnh, trả về dòng đầu tiên hoặc null. */
  async one(sql, params = []) {
    const rows = await this.q(sql, params);
    return rows[0] ?? null;
  }

  /* ---------------- TÀI KHOẢN ---------------- */

  async register(username, password, displayName) {
    const user = normalizeUsername(username);
    if (user.length < 3) throw new Error('Tên đăng nhập phải từ 3 ký tự');
    if (user.length > 20) throw new Error('Tên đăng nhập tối đa 20 ký tự');
    if (!/^[a-z0-9_]+$/.test(user)) {
      throw new Error('Tên đăng nhập chỉ gồm chữ thường, số và dấu gạch dưới');
    }
    if (String(password ?? '').length < 6) {
      throw new Error('Mật khẩu phải từ 6 ký tự');
    }

    const { salt, hash } = hashPassword(password);
    const name = cleanDisplayName(displayName || username);

    // ON CONFLICT thay cho "kiểm tra rồi mới ghi": hai người đăng ký cùng tên
    // cùng lúc thì chỉ một người thành công, không có kẽ hở.
    const row = await this.one(
      `INSERT INTO accounts (username, salt, pass_hash, display_name, balance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [user, salt, hash, name, STARTING_BALANCE, Date.now()],
    );
    if (!row) throw new Error('Tên đăng nhập đã có người dùng');
    return this.getAccount(row.id);
  }

  async login(username, password) {
    const row = await this.findByUsername(normalizeUsername(username));
    if (!row) throw new Error('Sai tên đăng nhập hoặc mật khẩu');
    if (!verifyPassword(String(password ?? ''), row.salt, row.pass_hash)) {
      throw new Error('Sai tên đăng nhập hoặc mật khẩu');
    }
    return this.getAccount(row.id);
  }

  async findByUsername(username) {
    const row = await this.one(
      'SELECT * FROM accounts WHERE username = $1',
      [normalizeUsername(username)],
    );
    return row ? { ...row, id: num(row.id), balance: num(row.balance) } : null;
  }

  /** Thông tin công khai của tài khoản (không kèm mật khẩu). */
  async getAccount(id) {
    const row = await this.one(
      'SELECT id, username, display_name, balance, created_at FROM accounts WHERE id = $1',
      [id],
    );
    if (!row) return null;
    return {
      id: num(row.id),
      username: row.username,
      displayName: row.display_name,
      balance: num(row.balance),
      createdAt: num(row.created_at),
    };
  }

  async getBalance(id) {
    const row = await this.one('SELECT balance FROM accounts WHERE id = $1', [id]);
    return row ? num(row.balance) : null;
  }

  /**
   * Đặt lại số dư về một con số cụ thể.
   * Dùng khi đồng bộ chip trên bàn về ví — engine là nguồn sự thật của ván,
   * ví chỉ chép lại kết quả.
   */
  async setBalance(id, balance) {
    if (!Number.isInteger(balance) || balance < 0) {
      throw new Error(`Số dư không hợp lệ: ${balance}`);
    }
    await this.pool.query('UPDATE accounts SET balance = $1 WHERE id = $2', [balance, id]);
    return balance;
  }

  /**
   * Cộng/trừ số dư trong MỘT câu lệnh. Điều kiện `balance + delta >= 0` nằm
   * ngay trong WHERE nên hai yêu cầu chạy song song không thể làm số dư âm.
   */
  async addBalance(id, delta) {
    const row = await this.one(
      `UPDATE accounts SET balance = balance + $1
       WHERE id = $2 AND balance + $1 >= 0
       RETURNING balance`,
      [delta, id],
    );
    if (row) return num(row.balance);
    const exists = await this.getBalance(id);
    if (exists === null) throw new Error('Không tìm thấy tài khoản');
    throw new Error('Số dư không đủ');
  }

  async renameAccount(id, displayName) {
    const name = cleanDisplayName(displayName);
    await this.pool.query('UPDATE accounts SET display_name = $1 WHERE id = $2', [name, id]);
    return name;
  }

  /* ---------------- PHIÊN ĐĂNG NHẬP ---------------- */

  async createSession(accountId) {
    const token = randomBytes(24).toString('base64url');
    await this.pool.query(
      'INSERT INTO sessions (token, account_id, created_at) VALUES ($1, $2, $3)',
      [token, accountId, Date.now()],
    );
    return token;
  }

  /** Trả về tài khoản của phiên, hoặc null nếu token sai/hết hạn. */
  async resolveSession(token, maxAgeMs = 30 * 24 * 3600 * 1000) {
    if (!token) return null;
    const row = await this.one('SELECT * FROM sessions WHERE token = $1', [token]);
    if (!row) return null;
    if (Date.now() - num(row.created_at) > maxAgeMs) {
      await this.destroySession(token);
      return null;
    }
    return this.getAccount(row.account_id);
  }

  async destroySession(token) {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  /* ---------------- ĐIỂM DANH ---------------- */

  /**
   * Thẻ điểm danh của tuần hiện tại: 7 ô từ thứ 2 tới chủ nhật.
   */
  async getCheckinCard(accountId, ts = Date.now()) {
    const { weekStart, dayIndex, date } = gameDay(ts);
    const rows = await this.q(
      'SELECT day_index, amount FROM checkins WHERE account_id = $1 AND week_start = $2',
      [accountId, weekStart],
    );
    const claimed = new Map(rows.map((r) => [r.day_index, num(r.amount)]));

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
      totalThisWeek: rows.reduce((s, r) => s + num(r.amount), 0),
      days,
    };
  }

  /**
   * Nhận thưởng điểm danh của HÔM NAY.
   * Chỉ nhận được ô của ngày hôm nay — bỏ ngày nào là mất ngày đó.
   *
   * Chạy trong một giao dịch: ghi ô điểm danh và cộng xu phải cùng thành công
   * hoặc cùng thất bại. `ON CONFLICT DO NOTHING` đảm bảo bấm mười lần cùng lúc
   * cũng chỉ ăn thưởng một lần.
   */
  async claimCheckin(accountId, ts = Date.now()) {
    const { weekStart, dayIndex } = gameDay(ts);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ghi = await client.query(
        `INSERT INTO checkins (account_id, week_start, day_index, amount, claimed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, week_start, day_index) DO NOTHING
         RETURNING 1`,
        [accountId, weekStart, dayIndex, CHECKIN_REWARD, ts],
      );
      if (ghi.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Hôm nay bạn đã điểm danh rồi');
      }
      const bal = await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [CHECKIN_REWARD, accountId],
      );
      if (bal.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Không tìm thấy tài khoản');
      }
      await client.query('COMMIT');
      return {
        ok: true,
        amount: CHECKIN_REWARD,
        balance: num(bal.rows[0].balance),
        card: await this.getCheckinCard(accountId, ts),
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  /* ---------------- TRANG QUẢN LÝ ---------------- */

  /**
   * Cộng (hoặc trừ, khi delta âm) xu cho một tài khoản theo TÊN ĐĂNG NHẬP,
   * đồng thời ghi vào sổ cái. Cả hai việc nằm trong một giao dịch.
   */
  async adminAdjust(username, delta, reason = '', ts = Date.now()) {
    const account = await this.findByUsername(username);
    if (!account) throw new Error(`Không có tài khoản nào tên "${username}"`);
    const amount = Math.trunc(Number(delta));
    if (!Number.isFinite(amount) || amount === 0) {
      throw new Error('Số xu phải là số nguyên khác 0');
    }
    const balanceBefore = account.balance;
    if (balanceBefore + amount < 0) {
      throw new Error(
        `Trừ ${Math.abs(amount).toLocaleString('vi-VN')} xu thì âm mất — tài khoản chỉ có ${balanceBefore.toLocaleString('vi-VN')} xu`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE accounts SET balance = balance + $1
         WHERE id = $2 AND balance + $1 >= 0
         RETURNING balance`,
        [amount, account.id],
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('Số dư không đủ');
      }
      const balanceAfter = num(upd.rows[0].balance);
      await client.query(
        `INSERT INTO admin_log (account_id, username, delta, balance_after, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [account.id, account.username, amount, balanceAfter, String(reason ?? '').slice(0, 200), ts],
      );
      await client.query('COMMIT');
      return {
        account: await this.getAccount(account.id),
        delta: amount,
        balanceBefore,
        balanceAfter,
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  /** Đặt thẳng số dư về một con số. Sổ cái ghi lại phần chênh lệch. */
  async adminSetBalance(username, value, reason = '', ts = Date.now()) {
    const account = await this.findByUsername(username);
    if (!account) throw new Error(`Không có tài khoản nào tên "${username}"`);
    const target = Math.trunc(Number(value));
    if (!Number.isInteger(target) || target < 0) {
      throw new Error('Số dư mới phải là số nguyên không âm');
    }
    const balanceBefore = account.balance;
    const delta = target - balanceBefore;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [target, account.id]);
      if (delta !== 0) {
        await client.query(
          `INSERT INTO admin_log (account_id, username, delta, balance_after, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [account.id, account.username, delta, target, String(reason ?? '').slice(0, 200), ts],
        );
      }
      await client.query('COMMIT');
      return {
        account: await this.getAccount(account.id),
        delta,
        balanceBefore,
        balanceAfter: target,
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  /** 20 giao dịch gần nhất, mới nhất lên đầu. */
  async adminLog(limit = 20) {
    const rows = await this.q(
      `SELECT username, delta, balance_after, reason, created_at
       FROM admin_log ORDER BY id DESC LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    );
    return rows.map((r) => ({
      username: r.username,
      delta: num(r.delta),
      balanceAfter: num(r.balance_after),
      reason: r.reason,
      at: num(r.created_at),
    }));
  }

  /** Danh sách tài khoản cho trang quản lý, có tìm kiếm theo tên. */
  async listAccounts({ q = '', limit = 50 } = {}) {
    const n = Math.max(1, Math.min(200, limit));
    const term = String(q ?? '').trim().toLowerCase();
    const rows = term
      ? await this.q(
          `SELECT id, username, display_name, balance, created_at FROM accounts
           WHERE LOWER(username) LIKE $1 OR LOWER(display_name) LIKE $1
           ORDER BY balance DESC LIMIT $2`,
          [`%${term}%`, n],
        )
      : await this.q(
          `SELECT id, username, display_name, balance, created_at FROM accounts
           ORDER BY balance DESC LIMIT $1`,
          [n],
        );
    return rows.map((r) => ({
      id: num(r.id),
      username: r.username,
      displayName: r.display_name,
      balance: num(r.balance),
      createdAt: num(r.created_at),
    }));
  }

  async countAccounts() {
    const row = await this.one('SELECT COUNT(*)::int AS n FROM accounts');
    return row.n;
  }

  /* ---------------- THỐNG KÊ ---------------- */

  /** Tổng xu toàn hệ thống — dùng để kiểm tra không có xu tự sinh ra. */
  async totalBalance() {
    const row = await this.one('SELECT COALESCE(SUM(balance),0) AS s FROM accounts');
    return num(row.s);
  }

  async topPlayers(limit = 10) {
    const rows = await this.q(
      'SELECT display_name, balance FROM accounts ORDER BY balance DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({ display_name: r.display_name, balance: num(r.balance) }));
  }
}

/** Rút một dòng dễ đọc từ object lỗi đồ sộ của driver Postgres. */
export function moTaLoi(err) {
  if (!err) return 'không rõ';
  const ma = err.code ? ` [${err.code}]` : '';
  return `${err.message ?? err}${ma}`;
}

/** Đoán nguyên nhân từ mã lỗi, để khỏi phải mò. */
export function goiYSua(err) {
  const code = err?.code;
  const msg = String(err?.message ?? '');

  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo')) {
    return 'Sai tên máy chủ trong DATABASE_URL. Copy lại chuỗi kết nối từ Neon.';
  }
  if (code === 'ECONNREFUSED') {
    return 'Không có Postgres nào lắng nghe ở địa chỉ/cổng đó.';
  }
  if (code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return 'Hết giờ chờ kết nối. Kiểm tra tường lửa, hoặc Neon đang ngủ và cần thêm thời gian.';
  }
  if (code === '28P01') {
    return 'Sai mật khẩu. Vào Neon lấy lại chuỗi kết nối (Reset password nếu cần).';
  }
  if (code === '3D000') {
    return 'Tên cơ sở dữ liệu trong chuỗi kết nối không tồn tại.';
  }
  if (code === '28000' || msg.includes('no pg_hba.conf')) {
    return 'Bị từ chối xác thực. Chuỗi kết nối Neon phải có ?sslmode=require ở cuối.';
  }
  if (msg.includes('SSL') || msg.includes('self signed') || msg.includes('certificate')) {
    return 'Vấn đề TLS. Chuỗi kết nối Neon phải có ?sslmode=require ở cuối.';
  }
  if (msg.includes('password must be a string')) {
    return 'DATABASE_URL thiếu mật khẩu, hoặc mật khẩu có ký tự đặc biệt chưa được mã hoá URL.';
  }
  if (code === '42501' || msg.includes('permission denied')) {
    return 'Tài khoản không có quyền tạo bảng trong cơ sở dữ liệu này.';
  }
  return 'Kiểm tra lại biến DATABASE_URL trong phần Environment của Render.';
}

/** Postgres trả BIGINT dưới dạng chuỗi để không mất độ chính xác. */
function num(v) {
  return v === null || v === undefined ? v : Number(v);
}

function isLocal(connectionString) {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)
    || connectionString.startsWith('postgresql:///')
    || connectionString.includes('host=/');
}

function normalizeUsername(username) {
  return String(username ?? '').trim().toLowerCase();
}

function cleanDisplayName(name) {
  const clean = String(name ?? '').replace(/[\x00-\x1f<>]/g, '').trim();
  return clean.slice(0, 20) || 'Khách';
}
