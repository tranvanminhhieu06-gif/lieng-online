/**
 * Tiện ích test: mỗi Store dùng một schema Postgres riêng, xoá sạch khi đóng.
 *
 * Nhờ vậy các file test chạy song song không giẫm chân nhau, và không cần
 * dựng nhiều cơ sở dữ liệu.
 *
 * Cần biến môi trường TEST_DATABASE_URL (hoặc DATABASE_URL) trỏ tới một
 * Postgres đang chạy. Xem README mục "Chạy test".
 */

import { Store } from '../src/server/db.js';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

let counter = 0;

/** Tên schema duy nhất cho mỗi lần gọi. */
export function uniqueSchema(prefix = 'test') {
  return `${prefix}_${process.pid}_${Date.now().toString(36)}_${++counter}`;
}

/**
 * Tạo một Store rỗng trong schema riêng.
 * Gọi `store.close()` khi xong — schema sẽ bị xoá theo.
 */
export async function newTestStore(prefix = 'test') {
  const schema = uniqueSchema(prefix);
  const store = new Store(TEST_DB_URL, { schema });
  await store.init();

  const dongGoc = store.close.bind(store);
  store.close = async () => {
    try {
      await store.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch { /* schema có thể đã bị xoá */ }
    await dongGoc();
  };
  store.schemaName = schema;
  return store;
}
