/**
 * Xếp hạng và so sánh bài Liêng (3 lá).
 *
 * Thứ tự từ cao xuống thấp:
 *   Sáp   — 3 lá cùng số (Sáp Á cao nhất)
 *   Liêng — 3 lá liên tiếp (Q-K-A cao nhất, A-2-3 thấp nhất)
 *   Ảnh   — 3 lá đều là J/Q/K nhưng không phải sáp/liêng
 *   Điểm  — tổng điểm 3 lá lấy hàng đơn vị (2-9 tính số, 10/J/Q/K = 0, A = 1)
 *
 * Khi cùng hạng thì so tiếp bằng mảng `tiebreak` (so từng phần tử từ trái sang).
 * Phần tử cuối luôn là sức mạnh từng lá bài (số rồi tới chất), nên hai người
 * gần như không bao giờ hoà.
 */

import { RANK_LABELS, SUIT_STRENGTH } from './cards.js';

export const CATEGORY = {
  DIEM: 0,
  ANH: 1,
  LIENG: 2,
  SAP: 3,
};

export const CATEGORY_NAMES = {
  [CATEGORY.DIEM]: 'diem',
  [CATEGORY.ANH]: 'anh',
  [CATEGORY.LIENG]: 'lieng',
  [CATEGORY.SAP]: 'sap',
};

/**
 * Các bộ Liêng hợp lệ, đã sắp xếp tăng dần, xếp theo độ mạnh tăng dần.
 * Lưu ý: [11,12,13] (J-Q-K) KHÔNG phải Liêng — bộ đó tính là Ảnh.
 * [1,12,13] (Q-K-A) là bộ Liêng mạnh nhất nên nằm cuối mảng.
 */
export const LIENG_TRIPLES = [
  [1, 2, 3],
  [2, 3, 4],
  [3, 4, 5],
  [4, 5, 6],
  [5, 6, 7],
  [6, 7, 8],
  [7, 8, 9],
  [8, 9, 10],
  [9, 10, 11],
  [10, 11, 12],
  [1, 12, 13],
];

/** Giá trị tính điểm của một lá: A = 1, 2-9 = số, 10/J/Q/K = 0. */
export function pointValue(rank) {
  if (rank === 1) return 1;
  if (rank >= 10) return 0;
  return rank;
}

/** Á là lá cao nhất khi so lá (14), không phải 1. */
export function highRank(rank) {
  return rank === 1 ? 14 : rank;
}

/**
 * Sức mạnh tuyệt đối của một lá bài: số trước, chất sau.
 * Nhân 4 để số luôn thắng chất khi so sánh.
 */
export function cardStrength(card) {
  return highRank(card.rank) * 4 + SUIT_STRENGTH[card.suit];
}

/**
 * Xếp hạng một bộ 3 lá.
 *
 * @param {{rank:number, suit:string}[]} cards
 * @param {{tiebreakBySuit?: boolean}} [options]
 *   tiebreakBySuit = false thì khi số bằng nhau sẽ coi là hoà (chia hũ),
 *   thay vì so chất.
 * @returns {{category:number, categoryName:string, tiebreak:number[], label:string, score:number|null}}
 */
export function evaluateHand(cards, options = {}) {
  const { tiebreakBySuit = true } = options;

  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('Bài Liêng phải có đúng 3 lá');
  }

  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);

  // Sức mạnh từng lá, xếp giảm dần — dùng làm tiêu chí phụ cuối cùng.
  const kickers = cards
    .map((c) => (tiebreakBySuit ? cardStrength(c) : highRank(c.rank) * 4))
    .sort((a, b) => b - a);

  // --- Sáp ---
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return {
      category: CATEGORY.SAP,
      categoryName: 'sap',
      tiebreak: [highRank(ranks[0])],
      label: `Sáp ${RANK_LABELS[ranks[0]]}`,
      score: null,
    };
  }

  // --- Liêng ---
  const liengIndex = LIENG_TRIPLES.findIndex(
    (t) => t[0] === ranks[0] && t[1] === ranks[1] && t[2] === ranks[2],
  );
  if (liengIndex !== -1) {
    const seqLabel =
      ranks[0] === 1 && ranks[1] === 12
        ? 'Q-K-A'
        : ranks.map((r) => RANK_LABELS[r]).join('-');
    return {
      category: CATEGORY.LIENG,
      categoryName: 'lieng',
      tiebreak: [liengIndex, ...kickers],
      label: `Liêng ${seqLabel}`,
      score: null,
    };
  }

  // --- Ảnh ---
  if (ranks.every((r) => r >= 11 && r <= 13)) {
    return {
      category: CATEGORY.ANH,
      categoryName: 'anh',
      tiebreak: [...kickers],
      label: 'Ảnh',
      score: null,
    };
  }

  // --- Điểm ---
  const score = cards.reduce((sum, c) => sum + pointValue(c.rank), 0) % 10;
  return {
    category: CATEGORY.DIEM,
    categoryName: 'diem',
    tiebreak: [score, ...kickers],
    label: `${score} điểm`,
    score,
  };
}

/**
 * So sánh hai kết quả xếp hạng.
 * @returns số dương nếu a mạnh hơn b, âm nếu yếu hơn, 0 nếu hoà tuyệt đối.
 */
export function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Điểm số 0-100 ước lượng độ mạnh của bộ bài — dùng cho AI của bot.
 */
export function handStrengthScore(cards, options) {
  const res = evaluateHand(cards, options);
  switch (res.category) {
    case CATEGORY.SAP:
      return 80 + res.tiebreak[0];
    case CATEGORY.LIENG:
      return 55 + res.tiebreak[0];
    case CATEGORY.ANH:
      return 40 + res.tiebreak[0] / 100;
    default:
      return res.score * 3;
  }
}
