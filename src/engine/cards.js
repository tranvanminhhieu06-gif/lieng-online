/**
 * Bộ bài & bộ sinh số ngẫu nhiên.
 *
 * Module này thuần tuý (không phụ thuộc DOM, không phụ thuộc Node API) nên
 * dùng được cả ở server lẫn trình duyệt lẫn trong test.
 */

// Thứ tự chất từ THẤP đến CAO (dùng để so bài khi hoà điểm).
// Bích < Chuồn < Rô < Cơ — theo cách chơi phổ biến ở Việt Nam.
export const SUITS = ['♠', '♣', '♦', '♥'];

export const SUIT_NAMES = {
  '♠': 'Bích',
  '♣': 'Chuồn',
  '♦': 'Rô',
  '♥': 'Cơ',
};

export const SUIT_STRENGTH = {
  '♠': 0,
  '♣': 1,
  '♦': 2,
  '♥': 3,
};

export const SUIT_COLOR = {
  '♠': 'black',
  '♣': 'black',
  '♦': 'red',
  '♥': 'red',
};

export const RANK_LABELS = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
};

/** Mã gọn của một lá bài, ví dụ `1♥`. Dùng để log và so sánh nhanh. */
export function cardCode(card) {
  return `${card.rank}${card.suit}`;
}

/** Nhãn hiển thị, ví dụ `A♥`. */
export function cardLabel(card) {
  return `${RANK_LABELS[card.rank]}${card.suit}`;
}

/** Bộ 52 lá. */
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Xáo bài Fisher–Yates.
 *
 * `randomInt(n)` phải trả về số nguyên trong [0, n).
 * Server truyền vào bộ sinh dựa trên crypto; test truyền vào bộ sinh có seed
 * để kết quả lặp lại được.
 */
export function shuffle(deck, randomInt) {
  if (typeof randomInt !== 'function') {
    throw new Error('shuffle() cần một hàm randomInt(n)');
  }
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Bộ sinh ngẫu nhiên có seed (mulberry32) — CHỈ dùng cho test và bot.
 * Không bao giờ dùng để chia bài thật.
 */
export function seededRandomInt(seed) {
  let s = seed >>> 0;
  return function randomInt(n) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * n);
  };
}
