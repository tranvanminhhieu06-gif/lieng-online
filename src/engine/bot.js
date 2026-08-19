/**
 * AI của nhà cái ảo — chạy ở SERVER, không phải ở trình duyệt.
 *
 * Giữ tinh thần của bản prototype (đánh theo độ mạnh bài, thỉnh thoảng tháu cáy)
 * nhưng nhận vào `legal` từ engine nên không thể ra hành động phạm luật.
 */

import { handStrengthScore } from './evaluate.js';

export const BOT_NAMES = [
  'Cô Sáu', 'Chú Tư', 'Anh Ba', 'Dì Bảy', 'Bác Hai', 'Cậu Út',
  'Chị Năm', 'Thím Tám', 'Anh Chín', 'Chú Mười', 'Bác Ba Phi', 'Cô Út',
];

export const BOT_PROFILES = {
  tight:  { bluffRate: 0.03, foldBelow: 20, raiseAbove: 62, raiseChance: 0.22 },
  normal: { bluffRate: 0.07, foldBelow: 16, raiseAbove: 58, raiseChance: 0.32 },
  loose:  { bluffRate: 0.14, foldBelow: 10, raiseAbove: 48, raiseChance: 0.45 },
};

/**
 * @param {object} bot     người chơi (đã có `hand`)
 * @param {object} legal   kết quả getLegalActions()
 * @param {object} ctx     { ante, random: ()=>number, profile }
 * @returns {{type:'fold'|'call'|'raise', amount?:number, actionSeq:number}}
 */
export function decideBotAction(bot, legal, ctx = {}) {
  const random = ctx.random ?? Math.random;
  const profile = BOT_PROFILES[ctx.profile] ?? BOT_PROFILES.normal;
  const ante = ctx.ante ?? 10;

  const strength = handStrengthScore(bot.hand);
  const bluff = random() < profile.bluffRate;
  const seq = legal.actionSeq;

  // Bị ép tất tay: chỉ theo nếu bài đủ mạnh
  if (legal.isAllInCall) {
    if (strength > 45 || bluff) return { type: 'call', actionSeq: seq };
    return { type: 'fold', actionSeq: seq };
  }

  // Bài quá yếu
  if (strength < profile.foldBelow && !bluff) {
    return legal.callAmount > 0
      ? { type: 'fold', actionSeq: seq }
      : { type: 'call', actionSeq: seq };
  }

  // Cân nhắc tố
  const wantsRaise =
    strength > profile.raiseAbove ||
    (strength > 32 && random() < profile.raiseChance) ||
    bluff;

  if (legal.canRaise && wantsRaise) {
    const steps = 1 + Math.floor(random() * 2);
    const target = Math.min(legal.minRaise + (steps - 1) * ante, legal.maxRaise);
    if (target >= legal.minRaise) {
      return { type: 'raise', amount: target, actionSeq: seq };
    }
  }

  return { type: 'call', actionSeq: seq };
}

/** Thời gian "suy nghĩ" giả lập tự nhiên, nhanh gọn không gây delay. */
export function botThinkDelay(random = Math.random) {
  return 300 + Math.floor(random() * 350);
}
