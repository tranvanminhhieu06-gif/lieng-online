/**
 * Bộ sinh ngẫu nhiên dùng để chia bài.
 *
 * `Math.random()` của bản offline không đủ: nó có thể đoán được nếu biết trạng
 * thái nội bộ, và quan trọng hơn là nó chạy ở client. Ở đây dùng CSPRNG của
 * hệ điều hành, và chỉ chạy trên server.
 */

import { randomInt as nodeRandomInt, randomBytes } from 'node:crypto';

/** Số nguyên ngẫu nhiên an toàn trong [0, n). */
export function cryptoRandomInt(n) {
  if (n <= 1) return 0;
  return nodeRandomInt(n);
}

/** Số thực ngẫu nhiên trong [0, 1) — dùng cho hành vi của bot. */
export function cryptoRandom() {
  return nodeRandomInt(0, 1_000_000) / 1_000_000;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bỏ I, O, 0, 1 cho dễ đọc

/** Mã phòng 6 ký tự dễ đọc qua điện thoại. */
export function makeRoomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_ALPHABET[cryptoRandomInt(ROOM_ALPHABET.length)];
  }
  return out;
}

/** Token bí mật để nhận lại ghế sau khi rớt mạng. */
export function makeToken() {
  return randomBytes(24).toString('base64url');
}

export function makeId(prefix = 'p') {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}
