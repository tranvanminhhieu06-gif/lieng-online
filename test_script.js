
(() => {
"use strict";

/* ================= HẰNG SỐ ================= */
const RANK_LABELS = {1:'A',2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K'};
const RED = new Set(['♥','♦']);
const STORE_KEY = 'lieng.session';

/* ================= TRẠNG THÁI CLIENT ================= */
const SESSION_KEY = 'lieng.auth';

const ui = {
  ws: null,
  connected: false,
  account: null,
  wallet: null,           // { tienGoc, chip, laiLo } khi đang ngồi bàn công khai
  sessionToken: null,
  checkin: null,
  authMode: 'login',
  code: null,
  playerId: null,
  token: null,
  spectating: false,
  isHost: false,
  state: null,
  room: null,
  turnDeadline: null,
  clockSkew: 0,
  names: {},
  soundOn: true,
  autoFlip: false,          // tự mở bài như kiểu cũ
  flipAnim: new Set(),      // chỉ số lá MÌNH vừa lật
  othersFlip: {},           // lá người khác vừa lật, để hiện họ đang xem bài
  showdownOrder: [],        // thứ tự ngửa bài cuối ván, tạo hiệu ứng dây chuyền
  chipTruoc: {},            // chip lần vẽ trước, để chạy số đếm dần
  potTruoc: undefined,
  raiseTarget: 0,
  reconnectDelay: 800,
  manualLeave: false,
};

const $ = (id) => document.getElementById(id);

/* ================= ÂM THANH ================= */
let actx = null;
function ctx(){ if(!actx) actx = new (window.AudioContext||window.webkitAudioContext)(); return actx; }
function tone(freq, dur, type='sine', gain=0.05, delayS=0){
  if(!ui.soundOn) return;
  try{
    const c = ctx();
    if(c.state === 'suspended') c.resume();
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = type; osc.frequency.value = freq; g.gain.value = gain;
    osc.connect(g); g.connect(c.destination);
    const t0 = c.currentTime + delayS;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.start(t0); osc.stop(t0 + dur + 0.01);
  }catch(e){}
}
const sfx = {
  deal(){ for(let i=0;i<4;i++) tone(520+i*30, .05, 'triangle', .035, i*.04); },
  chip(){ tone(880,.04,'square',.025); tone(660,.04,'square',.02,.02); },
  fold(){ tone(220,.14,'sawtooth',.025); },
  win(){ [523,659,784,1046].forEach((f,i)=>tone(f,.18,'sine',.04,i*.07)); },
  turn(){ tone(700,.08,'sine',.04); tone(940,.08,'sine',.035,.08); },
  flip(){ tone(420,.06,'triangle',.04); tone(680,.07,'triangle',.035,.04); },
  flipNhe(){ tone(340,.04,'triangle',.02); },
  // Chia bài: mỗi lá một tiếng "xoẹt", lệch nhau đúng nhịp với hoạt ảnh
  chiaBai(soNguoi){
    const soLa = Math.min(soNguoi || 3, 6) * 3;
    for(let i = 0; i < soLa; i++){
      tone(560 + (i % 3) * 45, .035, 'triangle', .025, i * 0.04);
    }
  },
};

/* ================= KẾT NỐI ================= */
function wsUrl(){
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

let pendingOnOpen = [];

function connect(onOpen){
  if(onOpen) pendingOnOpen.push(onOpen);
  if(ui.ws && ui.ws.readyState === 1){
    const queue = pendingOnOpen.slice();
    pendingOnOpen = [];
    queue.forEach(cb => { try{ cb(); }catch{} });
    return;
  }
  if(ui.ws && ui.ws.readyState === 0){
    return; // Đang nối, onopen sẽ gọi hết callback trong hàng đợi
  }
  const ws = new WebSocket(wsUrl());
  ui.ws = ws;

  ws.onopen = () => {
    ui.connected = true;
    ui.reconnectDelay = 800;
    setConn('ok', 'đã kết nối');
    const queue = pendingOnOpen.slice();
    pendingOnOpen = [];
    queue.forEach(cb => { try{ cb(); }catch{} });
  };
  ws.onclose = () => {
    ui.connected = false;
    setConn('off', 'mất kết nối');
    if(ui.manualLeave) return;
    if(ui.code && ui.token){
      setConn('warn', 'đang kết nối lại…');
      setTimeout(() => connect(() => sendRaw({t:'resume', code:ui.code, token:ui.token})), ui.reconnectDelay);
      ui.reconnectDelay = Math.min(ui.reconnectDelay * 1.7, 10000);
    }
  };
  ws.onerror = () => {
    if($('auth')?.classList.contains('show')){
      $('authErr').textContent = 'Không thể kết nối tới máy chủ. Vui lòng thử lại.';
    }
  };
  ws.onmessage = (ev) => {
    let msg; try{ msg = JSON.parse(ev.data); }catch{ return; }
    handle(msg);
  };
}

function sendRaw(obj){
  if(ui.ws?.readyState === 1){
    ui.ws.send(JSON.stringify(obj));
  } else {
    connect(() => {
      if(ui.ws?.readyState === 1) ui.ws.send(JSON.stringify(obj));
    });
  }
}

function setConn(kind, text){
  const dot = $('connDot');
  dot.className = 'dot' + (kind==='off' ? ' off' : kind==='warn' ? ' warn' : '');
  $('connText').textContent = text;
}

/* ================= XỬ LÝ TIN TỪ SERVER ================= */
function handle(msg){
  switch(msg.t){
    case 'auth-ok': {
      ui.account = msg.account;
      if(msg.sessionToken){
        ui.sessionToken = msg.sessionToken;
        try{ localStorage.setItem(SESSION_KEY, msg.sessionToken); }catch{}
      }
      ui.checkin = msg.checkin;
      $('authErr').textContent = '';
      showScreen('lobby');
      renderWallet();
      renderCheckin();
      break;
    }
    case 'lobby':
      ui.account = msg.account;
      ui.checkin = msg.checkin;
      renderWallet();
      renderCheckin();
      renderTiers(msg.tiers);
      break;
    case 'account':
      ui.account = msg.account;
      renderWallet();
      break;
    case 'checkin-result':
      ui.account = msg.account;
      ui.checkin = msg.card;
      renderWallet(true);
      renderCheckin();
      $('ckMsg').textContent = `Đã nhận ${fmtXu(msg.amount)} xu. Mai nhớ quay lại!`;
      sfx.win();
      break;
    case 'logged-out':
      ui.account = null;
      ui.sessionToken = null;
      try{ localStorage.removeItem(SESSION_KEY); localStorage.removeItem(STORE_KEY); }catch{}
      showScreen('auth');
      break;
    case 'kicked-from-table':
      if (msg.cashOut && typeof msg.cashOut.chip === 'number' && ui.account) {
        ui.account.balance = msg.cashOut.chip;
      }
      baoChotSo(msg.cashOut);
      ui.code = null;
      ui.token = null;
      ui.playerId = null;
      ui.wallet = null;
      try{ localStorage.removeItem(STORE_KEY); }catch{}
      sendRaw({t:'leave'}); // dọn nốt phiên phía server
      showScreen('lobby');
      renderWallet(true);
      sendRaw({t:'lobby'});
      toast(msg.reason);
      break;
    case 'joined': {
      ui.code = msg.code;
      ui.playerId = msg.playerId ?? null;
      ui.spectating = !!msg.spectating;
      ui.isHost = !!msg.isHost;
      if(msg.token){
        ui.token = msg.token;
        try{ localStorage.setItem(STORE_KEY, JSON.stringify({code:msg.code, token:msg.token})); }catch{}
      }
      $('txtCode').textContent = msg.code;
      $('pillTier').style.display = msg.tier ? 'flex' : 'none';
      $('pillCode').style.display = msg.tier ? 'none' : 'flex';
      if(msg.tier) $('txtTier').textContent = msg.tier.label;
      history.replaceState(null, '', msg.tier ? '/' : `/r/${msg.code}`);
      showGame();
      renderWallet();
      if(msg.reason) toast(msg.reason);
      if(msg.resumed) logLine('Đã nối lại bàn.');
      break;
    }
    case 'state':
      ui.room = msg.room;
      ui.state = msg.state;
      ui.wallet = msg.wallet ?? null;
      ui.turnDeadline = msg.turnDeadline;
      ui.clockSkew = msg.serverTime ? (Date.now() - msg.serverTime) : 0;
      ui.isHost = msg.room.hostId === ui.playerId;
      renderHistory(msg.history);
      render();
      break;
    case 'events':
      ui.names = { ...ui.names, ...(msg.names || {}) };
      msg.events.forEach(applyEvent);
      break;
    case 'chat':
      addChat(msg.msg);
      break;
    case 'chat-history':
      $('chatBox').innerHTML = '';
      (msg.msgs || []).forEach(addChat);
      break;
    case 'error':
      if($('auth').classList.contains('show')) $('authErr').textContent = msg.message;
      else toast(msg.message);
      break;
    case 'left':
      if (msg.account) {
        ui.account = msg.account;
      } else if (ui.account && msg.cashOut && typeof msg.cashOut.chip === 'number') {
        ui.account.balance = msg.cashOut.chip;
      }
      baoChotSo(msg.cashOut);
      ui.code = null;
      ui.wallet = null;
      try{ localStorage.removeItem(STORE_KEY); }catch{}
      history.replaceState(null, '', '/');
      showScreen('lobby');
      renderWallet(true);
      break;
  }
}

/** Thông báo chốt sổ khi rời bàn: mang vào bao nhiêu, ra về bao nhiêu. */
function baoChotSo(w){
  if(!w) return;
  if(w.laiLo > 0){
    toast(`Rời bàn với ${fmtXu(w.chip)} xu — lãi ${fmtXu(w.laiLo)}. Đã cộng vào tiền gốc.`);
    sfx.win();
  } else if(w.laiLo < 0){
    toast(`Rời bàn với ${fmtXu(w.chip)} xu — lỗ ${fmtXu(-w.laiLo)} so với ${fmtXu(w.tienGoc)} lúc vào.`);
  } else {
    toast(`Rời bàn hoà vốn, vẫn ${fmtXu(w.chip)} xu.`);
  }
}

/* ================= SẢNH ================= */
function showScreen(name){
  for(const id of ['auth','lobby']){
    $(id).classList.toggle('show', id === name);
  }
  $('game').classList.toggle('show', name === 'game');
}

/**
 * Rút gọn số tiền cho dễ đọc: 1.000 = 1k, 1.000.000 = 1B, 1.000.000.000 = 1T.
 * Giữ tối đa một chữ số thập phân, bỏ phần .0 thừa.
 */
function fmtXu(n){
  const so = Number(n ?? 0);
  const dau = so < 0 ? '-' : '';
  const v = Math.abs(so);
  const gon = (x) => String(Math.round(x * 10) / 10);
  if(v >= 1e9) return dau + gon(v / 1e9) + 'T';
  if(v >= 1e6) return dau + gon(v / 1e6) + 'B';
  if(v >= 1e3) return dau + gon(v / 1e3) + 'k';
  return dau + String(Math.round(v));
}

/** Số đầy đủ, dùng cho tooltip khi cần biết chính xác. */
const fmtDayDu = (n) => Number(n ?? 0).toLocaleString('vi-VN');

function renderWallet(bump = false){
  if(!ui.account) return;
  $('lbName').textContent = ui.account.displayName;
  const el = $('lbBalance');
  el.textContent = fmtXu(ui.account.balance);
  if(bump){
    el.classList.remove('bump');
    void el.offsetWidth; // ép trình duyệt chạy lại hoạt ảnh
    el.classList.add('bump');
  }
  const bal = $('gameBalance');
  if(bal) bal.textContent = fmtXu(ui.account.balance);
}

function renderCheckin(){
  const card = ui.checkin;
  if(!card) return;
  $('checkinGrid').innerHTML = card.days.map((d) => {
    const cls = ['cd'];
    if(d.claimed) cls.push('claimed');
    else if(d.today) cls.push('today', 'can');
    else if(d.future) cls.push('future');
    else cls.push('missed');
    if(d.today && d.claimed) cls.push('today');
    const ico = d.claimed ? '✓' : d.missed ? '·' : '🪙';
    return `<div class="${cls.join(' ')}">
      <div class="d">${d.label}</div>
      <div class="ico">${ico}</div>
      <div class="v">${Math.round(d.reward / 1000)}K</div>
    </div>`;
  }).join('');

  $('ckSummary').textContent = `${card.claimedThisWeek}/7 ngày · ${fmtXu(card.totalThisWeek)} xu`;

  const btn = $('btnCheckin');
  btn.disabled = !card.canClaimToday;
  btn.textContent = card.canClaimToday
    ? 'Điểm danh nhận 10.000 xu'
    : 'Hôm nay đã điểm danh — mai quay lại nhé';
  // Chỉ xoá lời chúc mừng khi đã sang ngày mới, chứ không xoá ngay sau khi nhận
  if(card.canClaimToday) $('ckMsg').textContent = '';
}

function renderTiers(tiers){
  $('tierList').innerHTML = tiers.map((t) => `
    <div class="tier ${t.canAfford ? '' : 'locked'}">
      <div class="chip-icon"></div>
      <div class="info">
        <div class="nm">${esc(t.label)}</div>
        <div class="meta">
          Tiền sàn ${fmtXu(t.ante)} · cần tối thiểu ${fmtXu(t.minBalance)} xu
          ${t.canAfford
            ? (t.playersOnline ? ` · <b style="color:#8ee0ac">${t.playersOnline} người đang chơi</b>` : ' · chưa có ai, vào trước rồi rủ bạn')
            : ` · <span class="warn">còn thiếu ${fmtXu(t.shortBy)} xu</span>`}
        </div>
      </div>
      <button data-tier="${esc(t.id)}" ${t.canAfford ? '' : 'disabled'}>
        ${t.canAfford ? 'Vào bàn' : 'Khoá'}
      </button>
    </div>`).join('');

  $('tierList').querySelectorAll('button[data-tier]').forEach((btn) => {
    btn.onclick = () => sendRaw({t:'join-tier', tierId: btn.dataset.tier});
  });
}

function nameOf(id){
  const p = ui.state?.players.find(x => x.id === id);
  return p?.name ?? ui.names[id] ?? 'Ai đó';
}

function applyEvent(e){
  switch(e.type){
    case 'round-start':
      logLine(`— Ván ${e.roundNum}: tiền sàn ${fmtXu(e.ante)} —`);
      if(typeof randomTheme==='function' && e.roundNum > 0 && e.roundNum % 3 === 0) setTheme(randomTheme());
      break;
    case 'deal':
      sfx.chiaBai(e.playerIds?.length ?? 3);
      ui.flipAnim.clear();
      ui.othersFlip = {};
      ui.showdownOrder = [];
      // Ai chọn "tự mở bài" thì lật hết ngay, khỏi bấm ba lần mỗi ván
      if(ui.autoFlip && !ui.spectating) sendRaw({t:'flip', all:true});
      break;
    case 'flip':
      if(e.playerId === ui.playerId){
        e.indexes.forEach((i) => ui.flipAnim.add(i));
        sfx.flip();
      } else {
        // Thấy đối thủ đang xem bài tới đâu (vẫn không thấy lá gì)
        ui.othersFlip[e.playerId] = e.indexes;
        sfx.flipNhe();
      }
      break;
    case 'action': {
      const n = nameOf(e.playerId);
      if(e.action === 'fold'){ sfx.fold(); logLine(e.blind ? `${n} úp bài mù, không thèm xem.` : `${n} úp bài.`); }
      else if(e.action === 'check'){ logLine(`${n} giữ bài.`); }
      else if(e.action === 'call'){ sfx.chip(); logLine(`${n} theo ${fmtXu(e.amount)}.`); }
      else if(e.action === 'allin-call'){ sfx.chip(); logLine(`${n} theo ${fmtXu(e.amount)} — tất tay!`); }
      else if(e.action === 'raise'){ sfx.chip(); logLine(`${n} tố lên ${fmtXu(e.total)}!`); }
      else if(e.action === 'allin-raise'){ sfx.chip(); logLine(`${n} tất tay ${fmtXu(e.total)}!`); }
      break;
    }
    case 'timeout':
      logLine(`${nameOf(e.playerId)} hết giờ suy nghĩ.`);
      break;
    case 'turn':
      if(e.playerId === ui.playerId) sfx.turn();
      break;
    case 'showdown':
      ui.showdownOrder = (e.reveals ?? []).map((r) => r.playerId);
      if(e.reveals?.length){
        e.reveals.forEach((r, i) => {
          setTimeout(() => sfx.flip(), i * 260);
          setTimeout(() => { if(typeof applyGlow==='function') applyGlow(r.playerId, r.hand?.label); }, i * 260 + 300);
        });
        logLine('Ngửa bài: ' + e.reveals.map(r => `${nameOf(r.playerId)} — ${r.hand.label}`).join(' · '));
      }
      break;
    case 'bonus': {
      const ten = nameOf(e.playerId);
      const heSo = e.multiplier === 2 ? 'ăn gấp đôi' : 'ăn gấp rưỡi';
      logLine(`${ten} — ${e.label}, ${heSo}! Được thêm ${fmtXu(e.total)} từ người thua.`);
      toast(`${ten}: ${e.label} — ${heSo}, +${fmtXu(e.total)}!`);
      sfx.win();
      if(typeof applyGlow==='function') applyGlow(e.playerId, e.label);
      break;
    }
    case 'round-end': {
      sfx.win();
      const names = e.winnerIds.map(nameOf).join(' & ');
      if(e.pots.length > 1){
        logLine(`Kết ván: ${e.pots.map((p,i) => `${i===0?'hũ chính':'hũ phụ '+i} ${fmtXu(p.amount)} → ${p.winners.map(nameOf).join(', ')}`).join(' · ')}`);
      } else {
        logLine(`${names} thắng ${fmtXu(e.totalPot)}!`);
      }
      break;
    }
    case 'eliminated':
      logLine(`${nameOf(e.playerId)} hết tiền, rời chiếu bạc.`);
      break;
    case 'game-over':
      showGameOver(e.winnerId);
      break;
  }
}

/* ================= VẼ BÀN ================= */
function seatPositions(n, felt){
  // Ghế của mình luôn ở dưới cùng, những người khác trải đều quanh bàn.
  // Bán kính tính theo kích thước thật của mặt bàn để ghế không tràn ra rìa
  // trên màn hình hẹp.
  const w = felt.clientWidth || 900;
  const h = felt.clientHeight || 500;
  const narrow = w < 560;
  const seatW = narrow ? 88 : 116;
  const seatH = narrow ? 112 : 156;
  const rx = Math.max(16, 50 - (seatW / 2 / w) * 100 - 2);
  const ry = Math.max(14, 50 - (seatH / 2 / h) * 100 - 2);

  const out = [];
  for(let i = 0; i < n; i++){
    const angle = (90 + (i * 360) / n) * Math.PI / 180;
    out.push({
      x: 50 + rx * Math.cos(angle),
      y: 50 + ry * Math.sin(angle),
    });
  }
  return out;
}

function orderedPlayers(){
  const players = (ui.state?.players ?? []).slice().sort((a,b) => a.seat - b.seat);
  if(!players.length) return players;
  const meIdx = players.findIndex(p => p.id === ui.playerId);
  if(meIdx <= 0) return players;
  return players.slice(meIdx).concat(players.slice(0, meIdx));
}

function cardHTML(card, opts = {}){
  const doTre = opts.delay ? ` style="animation-delay:${opts.delay}ms"` : '';
  const hieuUng = (opts.dealing ? ' dang-chia' : '')
    + (opts.justFlipped ? ' just-flipped' : '')
    + (opts.showdown ? ' ngua-bai' : '');

  if(!card){
    const cls = 'card card-back' + (opts.flippable ? ' flippable' : '') + hieuUng;
    const attr = opts.flippable ? ` data-flip="${opts.index}" title="Bấm để mở lá này"` : '';
    return `<div class="${cls}"${attr}${doTre}></div>`;
  }
  const red = RED.has(card.suit) ? 'red' : '';
  const label = RANK_LABELS[card.rank];
  return `<div class="card ${red}${hieuUng}"${doTre}><div>${label}</div><div class="suit-big">${card.suit}</div><div class="bl">${label}</div></div>`;
}

/* ================= VẼ BÀN ================= */

/** Chỉ ghi vào DOM khi giá trị thật sự đổi — tránh nhấp nháy và mất hoạt ảnh. */
function setText(el, giaTri){
  if(el && el.textContent !== String(giaTri)) el.textContent = giaTri;
}
function setHTML(el, giaTri){
  if(el && el.innerHTML !== giaTri) el.innerHTML = giaTri;
}
function setClass(el, ten, bat){
  if(el) el.classList.toggle(ten, !!bat);
}

/** Số tiền đếm tăng/giảm dần thay vì nhảy cóc. */
function chaySo(el, tuGiaTri, toiGiaTri, thoiGian = 280){
  if(!el) return;
  if(tuGiaTri === toiGiaTri || isNaN(tuGiaTri) || isNaN(toiGiaTri)){ setText(el, fmtXu(toiGiaTri)); return; }
  const batDau = performance.now();
  if(el._raf) cancelAnimationFrame(el._raf);
  const buoc = (luc) => {
    const t = Math.min(1, (luc - batDau) / thoiGian);
    const muot = 1 - Math.pow(1 - t, 3);
    setText(el, fmtXu(Math.round(tuGiaTri + (toiGiaTri - tuGiaTri) * muot)));
    if(t < 1) el._raf = requestAnimationFrame(buoc);
    else el._raf = null;
  };
  el._raf = requestAnimationFrame(buoc);
}

/** Dựng khung một ghế đúng một lần, các lần sau chỉ cập nhật nội dung. */
function dungGhe(felt, p){
  const el = document.createElement('div');
  el.id = 'seat-' + p.id;
  el.className = 'seat';
  el.innerHTML = `
    <div class="seat-badge-glow"></div>
    <div class="seat-name"></div>
    <div class="seat-chips"></div>
    <div class="cards-row"></div>
    <div class="hand-label"></div>
    <div class="seat-bet"></div>
    <div class="timer-bar"><i></i></div>`;
  felt.appendChild(el);
  return el;
}

/**
 * Vẽ hàng bài của một ghế.
 *
 * Chỉ dựng lại DOM khi bộ bài THẬT SỰ đổi (số lá, lá nào đã lật). Nếu dựng lại
 * mỗi lần nhận state thì hoạt ảnh bị khởi động lại liên tục, nhìn như giật lag.
 */
function veBai(el, p, st, isMe){
  const hang = el.querySelector('.cards-row');
  const conCheDay = isMe && st.phase === 'betting' && !p.folded;

  // Chữ ký của bộ bài — đổi thì mới vẽ lại
  const kyHieu = [
    p.cardCount,
    conCheDay ? 'c' : '-',
    ...Array.from({length: p.cardCount ?? 0}, (_, k) => {
      const la = p.cards?.[k];
      return la ? `${la.rank}${la.suit}` : 'x';
    }),
  ].join('|');
  if(hang.dataset.ky === kyHieu) return;

  const laMoiChia = hang.dataset.ky === undefined || !hang.dataset.ky.startsWith(String(p.cardCount));
  const thuTuNgua = ui.showdownOrder.indexOf(p.id);

  hang.innerHTML = Array.from({length: p.cardCount ?? 0}, (_, k) => {
    const la = p.cards?.[k];
    const vuaLat = (isMe && ui.flipAnim.has(k)) || (!isMe && ui.othersFlip[p.id]?.includes(k));
    return cardHTML(la, {
      flippable: conCheDay && !la,
      index: k,
      justFlipped: vuaLat,
      // Chia bài: lá bay từ giữa bàn ra, nhanh và mượt
      dealing: laMoiChia && st.phase === 'betting',
      delay: laMoiChia ? k * 45 : (thuTuNgua >= 0 ? thuTuNgua * 130 + k * 35 : 0),
      // Ngửa bài cuối ván: mỗi người lật lần lượt
      showdown: thuTuNgua >= 0 && !!la && !isMe,
    });
  }).join('');
  hang.dataset.ky = kyHieu;

  if(conCheDay){
    hang.querySelectorAll('.card[data-flip]').forEach((c) => {
      c.onclick = () => {
        const idx = +c.dataset.flip;
        c.classList.add('just-flipped');
        ui.flipAnim.add(idx);
        sfx.flip();
        sendRaw({t:'flip', index: idx});
      };
    });
  }
}

function render(){
  const st = ui.state;
  if(!st) return;

  const felt = $('felt');
  const players = orderedPlayers();
  const pos = seatPositions(Math.max(players.length, 1), felt);
  const feltRect = { w: felt.clientWidth || 900, h: felt.clientHeight || 500 };

  // Xoá ghế của người đã rời bàn
  const conLai = new Set(players.map(p => 'seat-' + p.id));
  felt.querySelectorAll('.seat').forEach(el => {
    if(!conLai.has(el.id)){
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }
  });

  players.forEach((p, i) => {
    let el = document.getElementById('seat-' + p.id);
    const vuaVao = !el;
    if(vuaVao) el = dungGhe(felt, p);

    el.style.left = pos[i].x + '%';
    el.style.top = pos[i].y + '%';
    // Toạ độ tương đối so với tâm bàn — dùng cho hoạt ảnh chia bài và bay chip
    el.style.setProperty('--dx', `${(50 - pos[i].x) / 100 * feltRect.w}px`);
    el.style.setProperty('--dy', `${(50 - pos[i].y) / 100 * feltRect.h}px`);

    const isMe = p.id === ui.playerId;
    const online = ui.room?.online?.[p.id];
    const isTurn = st.turnPlayerId === p.id;
    const isWinner = st.lastResult?.winnerIds?.includes(p.id) && st.phase !== 'betting';

    setClass(el, 'me', isMe);
    setClass(el, 'turn', isTurn);
    setClass(el, 'folded', p.folded);
    setClass(el, 'eliminated', p.eliminated);
    setClass(el, 'offline', !p.isBot && online === false);
    setClass(el, 'winner', isWinner);
    setClass(el, 'joining', vuaVao);
    if(vuaVao) setTimeout(() => el.classList.remove('joining'), 500);

    const tags = [];
    if(p.id === ui.room?.hostId && !ui.room?.walletMode) tags.push('<span class="tag">CHỦ</span>');
    if(p.isBot) tags.push('<span class="tag bot">BOT</span>');
    if(!p.isBot && online === false) tags.push('<span class="tag off">RỚT</span>');
    if(p.allIn) tags.push('<span class="tag">TẤT TAY</span>');
    if(st.dealerId === p.id) tags.push('<span class="tag">D</span>');
    setHTML(el.querySelector('.seat-name'), esc(p.name) + tags.join(''));

    // Chip: đếm dần cho thấy được ăn/mất bao nhiêu
    const oChip = el.querySelector('.seat-chips');
    const chipCu = ui.chipTruoc[p.id];
    oChip.title = fmtDayDu(p.chips) + ' xu';
    if(chipCu === undefined || chipCu === p.chips) setText(oChip, fmtXu(p.chips));
    else chaySo(oChip, chipCu, p.chips);
    if(chipCu !== undefined && p.chips > chipCu){
      oChip.classList.remove('an-tien'); void oChip.offsetWidth; oChip.classList.add('an-tien');
    }
    ui.chipTruoc[p.id] = p.chips;

    veBai(el, p, st, isMe);

    const chuaMo = isMe && p.cardCount ? p.cardCount - (p.revealedCount ?? 0) : 0;
    const conCheDay = isMe && st.phase === 'betting' && !p.folded;
    const nhan = el.querySelector('.hand-label');
    const dangNhac = conCheDay && chuaMo > 0;
    setClass(nhan, 'nhac-mo', dangNhac);
    setText(nhan, dangNhac ? `Bấm để mở — còn ${chuaMo} lá` : (p.handLabel ?? ''));

    setText(el.querySelector('.seat-bet'), p.betThisRound > 0 ? 'cược ' + fmtXu(p.betThisRound) : '');
    el.querySelector('.timer-bar').style.visibility = isTurn ? 'visible' : 'hidden';
  });

  ui.flipAnim.clear();
  ui.othersFlip = {};

  // Hũ — cũng đếm dần
  const oHu = $('potTotal');
  if(ui.potTruoc === undefined || ui.potTruoc === st.pot) setText(oHu, fmtXu(st.pot));
  else chaySo(oHu, ui.potTruoc, st.pot);
  ui.potTruoc = st.pot;

  const soCoin = Math.max(0, Math.min(8, Math.round(st.pot / Math.max(1, st.ante))));
  const stack = $('coinStack');
  if(stack){
    if(stack.children.length !== soCoin){
      while(stack.children.length < soCoin){
        const c = document.createElement('div');
        c.className = 'coin roi-xuong';
        stack.appendChild(c);
      }
      while(stack.children.length > soCoin) stack.removeChild(stack.lastChild);
    }
  }

  setText($('txtRound'), st.roundNum);
  setText($('phaseBadge'), phaseText(st.phase));

  // Bàn công khai: hiện cả tiền gốc lúc ngồi vào lẫn chip đang cầm, kèm lãi/lỗ.
  const me = st.players.find((p) => p.id === ui.playerId);
  if(ui.wallet){
    const w = ui.wallet;
    const dau = w.laiLo > 0 ? '+' : '';
    const mau = w.laiLo > 0 ? '#8ee0ac' : w.laiLo < 0 ? '#ff9d9d' : '#a2977c';
    setHTML($('walletText'),
      `Gốc <b>${fmtXu(w.tienGoc)}</b> · Bàn <b>${fmtXu(w.chip)}</b>`
      + (w.laiLo !== 0 ? ` <b style="color:${mau}">${dau}${fmtXu(w.laiLo)}</b>` : ''));
  } else if(ui.room?.walletMode && me){
    setHTML($('walletText'), `Bàn <b>${fmtXu(me.chips)}</b>`);
  } else if(ui.account){
    setHTML($('walletText'), `Xu <b>${fmtXu(ui.account.balance)}</b>`);
  }

  // Live Status Notice bar
  const noticeEl = $('statusNotice');
  if(noticeEl){
    if(st.phase === 'betting'){
      const turnName = nameOf(st.turnPlayerId);
      setText(noticeEl, st.turnPlayerId === ui.playerId ? '⭐ Tới lượt bạn đặt cược!' : `Đang chờ ${turnName} hành động...`);
    } else if(st.phase === 'waiting'){
      setText(noticeEl, 'Đang chờ người chơi khác vào bàn... Chia link mời hoặc đợi một chút.');
    } else if(st.phase === 'showdown'){
      setText(noticeEl, '🃏 Đang ngửa bài so điểm...');
    } else if(st.phase === 'roundOver'){
      setText(noticeEl, 'Hết ván — chuẩn bị chia ván mới...');
    } else {
      setText(noticeEl, '');
    }
  }

  renderControls();
  renderStats();
}

function phaseText(phase){
  return {
    waiting: 'chờ đủ người',
    betting: '',
    showdown: 'ngửa bài',
    roundOver: 'hết ván',
    gameOver: 'tan sòng',
  }[phase] ?? '';
}

function renderControls(){
  const st = ui.state;
  const hud = $('hud');
  hud.style.display = 'flex';
  if(ui.spectating){
    // Khán giả vẫn theo dõi được diễn biến, chỉ không có nút bấm.
    $('stepper').style.display = 'none';
    document.querySelector('.action-buttons').style.display = 'none';
    $('hostRow').style.display = 'none';
    $('callInfo').textContent = 'Bạn đang xem bàn này.';
    return;
  }

  const legal = st.legal;
  const me = st.players.find(p => p.id === ui.playerId);

  // Nút "Mở hết" hiện bất cứ lúc nào mình còn lá chưa lật, kể cả chưa tới lượt
  const conChuaMo = st.phase === 'betting' && me && !me.folded && me.cardCount > 0
    && (me.revealedCount ?? 0) < me.cardCount;
  $('btnFlipAll').style.display = conChuaMo ? 'block' : 'none';

  const hostRow = $('hostRow');
  // Bàn công khai tự chia ván và không cho chia lại vốn — ba nút này chỉ tổ
  // chiếm chỗ và báo lỗi khi bấm, nên ẩn hẳn đi.
  hostRow.style.display = (ui.isHost && !ui.room?.walletMode) ? 'flex' : 'none';
  $('btnStart').disabled = !(ui.room?.canStart && st.phase !== 'betting' && st.phase !== 'showdown');
  $('btnAddBot').disabled = (st.players.length >= (ui.room?.config?.maxPlayers ?? 6)) || st.phase === 'betting';

  const enable = (to, theo, up) => {
    $('btnTo').disabled = !to; $('btnTheo').disabled = !theo; $('btnUp').disabled = !up;
  };

  if(!legal){
    $('stepper').style.display = 'none';
    $('quickBets').style.display = 'none';
    enable(false, false, false);
    if(me?.folded && st.phase === 'betting'){
      $('callInfo').textContent = 'Bạn đã úp bài — ngồi xem tới hết ván.';
    } else if(st.phase === 'betting'){
      $('callInfo').textContent = st.turnPlayerId
        ? `Đang chờ ${nameOf(st.turnPlayerId)}…`
        : 'Đang xử lý…';
    } else if(st.phase === 'waiting'){
      const soNguoi = st.players.filter((x) => !x.eliminated).length;
      $('callInfo').textContent = ui.room?.walletMode
        // Bàn công khai không có bot và tự chia ván khi đủ người
        ? (soNguoi < 2
            ? 'Đang chờ người chơi khác vào bàn… Chia link mời hoặc đợi một chút.'
            : 'Sắp chia bài…')
        : (ui.isHost ? 'Đủ người thì bấm "Bắt đầu ván".' : 'Đang chờ chủ bàn bắt đầu…');
    } else if(st.phase === 'roundOver'){
      $('callInfo').textContent = ui.room?.config?.autoStart
        ? 'Hết ván — ván mới sắp bắt đầu…'
        : 'Hết ván.';
    } else if(me?.eliminated){
      $('callInfo').textContent = 'Bạn đã hết tiền — đang xem tiếp.';
    } else {
      $('callInfo').textContent = '';
    }
    return;
  }

  // Tới lượt mình
  ui.raiseTarget = clamp(ui.raiseTarget || legal.minRaise, legal.minRaise, legal.maxRaise);
  $('raiseAmt').textContent = fmtXu(ui.raiseTarget);
  $('stepper').style.display = legal.canRaise ? 'flex' : 'none';
  renderQuickBets(legal);
  enable(legal.canRaise, legal.canCall, legal.canFold);

  if(!legal.allRevealed){
    const thieu = 3 - legal.revealedCount;
    $('btnTheo').textContent = 'Theo';
    $('btnUp').textContent = 'Úp mù';
    $('callInfo').innerHTML =
      `Tới lượt bạn — mở nốt <span class="count">${thieu}</span> lá rồi mới đặt cược được. `
      + `<span class="count" id="cdown"></span>`;
    return;
  }

  $('btnUp').textContent = 'Úp';
  $('btnTheo').textContent = legal.payToCall > 0
    ? `Theo ${fmtXu(legal.payToCall)}${legal.isAllInCall ? ' • tất tay' : ''}`
    : 'Theo (giữ)';
  $('callInfo').innerHTML = legal.callAmount > 0
    ? `Cần theo <span class="count">${fmtXu(legal.payToCall)}</span>. <span class="count" id="cdown"></span>`
    : `Chưa ai tố — giữ bài miễn phí. <span class="count" id="cdown"></span>`;
}

/** Các mức tố nhanh, tính theo "tố thêm bao nhiêu so với mức đang có". */
const MUC_TO_NHANH = [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000];

function renderQuickBets(legal){
  const box = $('quickBets');
  if(!legal.canRaise){ box.style.display = 'none'; return; }
  box.style.display = 'flex';

  const st = ui.state;
  box.innerHTML = MUC_TO_NHANH.map((them) => {
    const dich = st.currentBet + them;
    // Mức nào thấp hơn mức tố tối thiểu, hoặc vượt số chip đang có, thì khoá
    const duoc = dich >= legal.minRaise && dich <= legal.maxRaise;
    const dangChon = duoc && ui.raiseTarget === dich;
    return `<button data-them="${them}" ${duoc ? '' : 'disabled'} class="${dangChon ? 'on' : ''}"
      title="Tố lên ${fmtDayDu(dich)}">+${fmtXu(them)}</button>`;
  }).join('');

  box.querySelectorAll('button[data-them]').forEach((b) => {
    b.onclick = () => {
      const l = ui.state?.legal; if(!l) return;
      ui.raiseTarget = clamp(ui.state.currentBet + (+b.dataset.them), l.minRaise, l.maxRaise);
      $('raiseAmt').textContent = fmtXu(ui.raiseTarget);
      renderQuickBets(l);
    };
  });
}

function renderStats(){
  const st = ui.state;
  if(!st) return;
  const rows = st.players.slice().sort((a,b) => b.chips - a.chips).map(p => `
    <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;">
      <span>${esc(p.name)}</span>
      <span style="font-family:'JetBrains Mono',monospace;color:var(--gold-bright)">
        ${fmtXu(p.chips)} · ${p.stats.roundsWon}/${p.stats.roundsPlayed} ván
      </span>
    </div>`).join('');
  $('statBox').innerHTML = rows;
}

function renderHistory(hist){
  if(!hist) return;
  const box = $('histBox');
  if(!hist.length){ box.innerHTML = '<div style="opacity:.6">Chưa có ván nào.</div>'; return; }
  box.innerHTML = hist.map(h => `
    <div class="hist-item">
      <div class="hd">Ván ${h.roundNum} — hũ ${fmtXu(h.totalPot)} → ${h.winners.map(w => esc(w.name)).join(', ')}</div>
      ${h.reveals.length ? '<div class="rv">' + h.reveals.map(r =>
        `${esc(r.name)}: ${r.cards.map(c => RANK_LABELS[c.rank]+c.suit).join(' ')} (${esc(r.label)})`
      ).join('<br>') + '</div>' : '<div class="rv" style="opacity:.6">không ngửa bài</div>'}
    </div>`).join('');
}

/* ================= ĐỒNG HỒ ĐẾM NGƯỢC ================= */
setInterval(() => {
  const st = ui.state;
  if(!st || st.phase !== 'betting' || !ui.turnDeadline){
    const cd = $('cdown'); if(cd) cd.textContent = '';
    return;
  }
  const left = Math.max(0, ui.turnDeadline + ui.clockSkew - Date.now());
  const secs = Math.ceil(left / 1000);
  const total = (ui.room?.config?.turnSeconds ?? 25) * 1000;

  const bar = document.getElementById('tb-' + st.turnPlayerId);
  if(bar){
    bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    bar.className = left < 6000 ? 'low' : '';
  }
  const cd = $('cdown');
  if(cd && st.turnPlayerId === ui.playerId){
    cd.textContent = `· còn ${secs}s`;
  }
}, 200);

/* ================= NHẬT KÝ & CHAT ================= */
function logLine(text){
  for(const [boxId, keep] of [['log', 1], ['logFull', 200]]){
    const box = $(boxId);
    if(!box) continue;
    const el = document.createElement('div');
    el.className = 'log-line';
    el.textContent = text;
    box.appendChild(el);
    while(box.children.length > keep) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
}

function addChat(msg){
  const el = document.createElement('div');
  el.className = 'chat-msg' + (msg.system ? ' sys' : '');
  el.innerHTML = msg.system
    ? esc(msg.text)
    : `<span class="who">${esc(msg.from)}:</span> ${esc(msg.text)}`;
  const box = $('chatBox');
  if(box){
    box.appendChild(el);
    while(box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  if(msg.system) logLine(msg.text);
  else {
    if(!$('panelChat')?.classList.contains('show')){
      $('btnChat')?.classList.add('active');
      if(typeof unreadChat!=='undefined'){ unreadChat++; updateChatBadge(); }
    }
    if(typeof showChatBubble==='function') showChatBubble(msg.from, msg.text);

    // Live mini chat dock at bottom right
    const dockFeed = $('chatDockFeed');
    if(dockFeed){
      const dMsg = document.createElement('div');
      dMsg.className = 'chat-dock-msg';
      dMsg.innerHTML = `<span class="who">${esc(msg.from)}:</span> ${esc(msg.text)}`;
      dockFeed.appendChild(dMsg);
      while(dockFeed.children.length > 5) dockFeed.removeChild(dockFeed.firstChild);
      setTimeout(()=>{
        dMsg.style.transition='opacity .6s ease, transform .6s ease';
        dMsg.style.opacity='0';
        dMsg.style.transform='translateX(20px)';
        setTimeout(()=>dMsg.remove(),600);
      }, 7000);
    }
  }
}

/* ================= TIỆN ÍCH ================= */
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

let toastTimer = null;
function toast(text){
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function showGame(){
  showScreen('game');
}

function showGameOver(winnerId){
  const ov = $('overlay');
  const me = winnerId === ui.playerId;
  $('ovTitle').textContent = me ? 'Bạn thắng cả chiếu!' : `${nameOf(winnerId)} thắng cả chiếu!`;
  $('ovText').textContent = me
    ? 'Bạn đã vơ hết tiền của cả bàn.'
    : 'Bàn chỉ còn lại một người còn tiền.';
  $('ovBtn').style.display = ui.isHost ? 'block' : 'none';
  ov.classList.add('show');
}

/* ================= SỰ KIỆN GIAO DIỆN ================= */
$('advToggle').onclick = () => $('advBody').classList.toggle('show');
$('privToggle').onclick = () => $('privBody').classList.toggle('show');

/* ---- Đăng nhập / đăng ký ---- */
function setAuthMode(mode){
  ui.authMode = mode;
  $('tabLogin').classList.toggle('on', mode === 'login');
  $('tabRegister').classList.toggle('on', mode === 'register');
  $('fieldDisplay').style.display = mode === 'register' ? 'flex' : 'none';
  $('btnAuth').textContent = mode === 'register' ? 'Đăng ký & nhận 50.000 xu' : 'Đăng nhập';
  $('inpPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('authHint').textContent = mode === 'register'
    ? 'Tài khoản mới được tặng 50.000 xu.'
    : 'Chưa có tài khoản? Bấm "Đăng ký".';
  $('authErr').textContent = '';
}
$('tabLogin').onclick = () => setAuthMode('login');
$('tabRegister').onclick = () => setAuthMode('register');

function submitAuth(){
  const username = $('inpUser').value.trim().toLowerCase();
  const password = $('inpPass').value;
  if(!username || !password){
    $('authErr').textContent = 'Nhập đủ tên đăng nhập và mật khẩu.';
    return;
  }
  $('authErr').textContent = '';
  ui.manualLeave = false;
  const payload = ui.authMode === 'register'
    ? {t:'register', username, password, displayName: $('inpDisplay').value.trim() || username}
    : {t:'login', username, password};
  connect(() => sendRaw(payload));
}
$('btnAuth').onclick = submitAuth;
for(const id of ['inpUser','inpPass','inpDisplay']){
  $(id).addEventListener('keydown', (e) => { if(e.key === 'Enter') submitAuth(); });
}

$('btnLogout').onclick = () => {
  ui.manualLeave = true;
  sendRaw({t:'logout', sessionToken: ui.sessionToken});
};

$('btnCheckin').onclick = () => {
  $('btnCheckin').disabled = true;
  sendRaw({t:'checkin'});
};

function readConfig(){
  return {
    ante: +$('cfgAnte').value,
    startChips: +$('cfgChips').value,
    maxPlayers: +$('cfgMax').value,
    turnSeconds: +$('cfgTurn').value,
    maxRaises: +$('cfgRaises').value,
    tiebreakBySuit: $('cfgTie').value === '1',
  };
}

$('btnCreate').onclick = () => {
  $('lobbyErr').textContent = '';
  sendRaw({t:'create', config: readConfig(), bots: +$('cfgBots').value});
};

function doJoin(spectate){
  const code = $('inpCode').value.trim().toUpperCase();
  if(code.length !== 6){ $('lobbyErr').textContent = 'Mã phòng gồm 6 ký tự.'; return; }
  $('lobbyErr').textContent = '';
  sendRaw({t:'join', code, spectate});
}
$('btnJoin').onclick = () => doJoin(false);
$('btnSpectate').onclick = () => doJoin(true);
$('inpCode').addEventListener('keydown', (e) => { if(e.key === 'Enter') doJoin(false); });

const act = (action, amount) => {
  const legal = ui.state?.legal;
  if(!legal) return;
  sendRaw({t:'action', action, amount, actionSeq: legal.actionSeq});
  $('btnTo').disabled = $('btnTheo').disabled = $('btnUp').disabled = true;
  $('callInfo').textContent = 'Đang gửi…';
};
$('btnTo').onclick = () => act('raise', ui.raiseTarget);
$('btnTheo').onclick = () => act('call');
$('btnUp').onclick = () => act('fold');

$('raiseMinus').onclick = () => {
  const l = ui.state?.legal; if(!l) return;
  ui.raiseTarget = clamp(ui.raiseTarget - l.raiseStep, l.minRaise, l.maxRaise);
  $('raiseAmt').textContent = fmtXu(ui.raiseTarget);
};
$('raisePlus').onclick = () => {
  const l = ui.state?.legal; if(!l) return;
  ui.raiseTarget = clamp(ui.raiseTarget + l.raiseStep, l.minRaise, l.maxRaise);
  $('raiseAmt').textContent = fmtXu(ui.raiseTarget);
};
$('raiseAllIn').onclick = () => {
  const l = ui.state?.legal; if(!l) return;
  ui.raiseTarget = l.maxRaise;
  $('raiseAmt').textContent = fmtXu(ui.raiseTarget);
};

$('btnStart').onclick = () => sendRaw({t:'start'});
$('btnAddBot').onclick = () => sendRaw({t:'add-bot'});
$('btnReset').onclick = () => { sendRaw({t:'reset'}); $('overlay').classList.remove('show'); };
$('ovBtn').onclick = () => { sendRaw({t:'reset'}); $('overlay').classList.remove('show'); };

$('btnLeave').onclick = () => {
  try{ localStorage.removeItem(STORE_KEY); }catch{}
  sendRaw({t:'leave'});
};

function togglePanel(id, btn){
  const panel = $(id);
  const wasShown = panel.classList.contains('show');
  document.querySelectorAll('.side').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.icon-btn').forEach(b => { if(b.id !== 'btnSound') b.classList.remove('active'); });
  if(!wasShown){ panel.classList.add('show'); btn.classList.add('active'); }
}
$('btnRules').onclick = (e) => togglePanel('panelRules', e.currentTarget);
$('btnLog').onclick = (e) => { togglePanel('panelLog', e.currentTarget); $('logFull').scrollTop = $('logFull').scrollHeight; };
$('btnChat').onclick = (e) => { togglePanel('panelChat', e.currentTarget); $('chatBox').scrollTop = $('chatBox').scrollHeight; if(typeof unreadChat!=='undefined'){unreadChat=0;updateChatBadge();} };
$('btnHist').onclick = (e) => togglePanel('panelHist', e.currentTarget);
$('btnSound').onclick = (e) => {
  ui.soundOn = !ui.soundOn;
  e.currentTarget.textContent = ui.soundOn ? '🔊' : '🔇';
};

$('btnFlipAll').onclick = () => {
  sfx.flip();
  document.querySelectorAll('.seat.me .card[data-flip]').forEach((c) => {
    c.classList.add('just-flipped');
    const idx = +c.dataset.flip;
    if (!isNaN(idx)) ui.flipAnim.add(idx);
  });
  sendRaw({t:'flip', all:true});
};

function setAutoFlip(on){
  ui.autoFlip = on;
  $('btnAutoFlip').classList.toggle('active', on);
  $('btnAutoFlip').title = on
    ? 'Đang tự mở bài — bấm để tự lật từng lá'
    : 'Đang tự lật từng lá — bấm để mở sẵn cả 3';
  try{ localStorage.setItem('lieng.autoflip', on ? '1' : '0'); }catch{}
}
$('btnAutoFlip').onclick = () => {
  setAutoFlip(!ui.autoFlip);
  toast(ui.autoFlip
    ? 'Từ ván sau bài sẽ tự mở sẵn cả 3 lá.'
    : 'Từ ván sau bạn tự lật từng lá cho hồi hộp.');
  // Đang giữa ván mà bật thì mở luôn ván này cho khỏi chờ
  if(ui.autoFlip && ui.state?.phase === 'betting') sendRaw({t:'flip', all:true});
};

function sendChat(){
  const inp = $('chatInput');
  const text = inp.value.trim();
  if(!text) return;
  sendRaw({t:'chat', text});
  inp.value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') sendChat(); });

$('pillCode').onclick = async () => {
  const link = `${location.origin}/r/${ui.code}`;
  try{
    await navigator.clipboard.writeText(link);
    toast('Đã chép link mời — gửi cho bạn bè!');
  }catch{
    prompt('Chép link này gửi cho bạn bè:', link);
  }
};

// Đổi kích thước cửa sổ / xoay điện thoại thì xếp lại ghế
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if(ui.state) render(); }, 120);
});

/* ================= THEME SYSTEM ================= */
const THEMES = ['sakura','bamboo','vietnam'];
const THEME_LABELS = {sakura:'🌸 Sakura',bamboo:'🐼 Bamboo',vietnam:'🏮 Hà Nội'};
const THEME_DECO = {sakura:['🌸','🌸'],bamboo:['🎋','🎋'],vietnam:['🏮','🏮']};
let currentTheme = null, particleTimer = null;

function setTheme(name){
  if(!THEMES.includes(name)) name = THEMES[0];
  currentTheme = name;
  document.body.dataset.theme = name;
  const dl = document.querySelector('.deco-left');
  const dr = document.querySelector('.deco-right');
  if(dl) dl.textContent = THEME_DECO[name]?.[0]||'';
  if(dr) dr.textContent = THEME_DECO[name]?.[1]||'';

  const emblem = $('centerEmblem');
  if(emblem) emblem.textContent = name==='sakura' ? '🌸' : (name==='vietnam' ? '🏮' : '🐼');

  const cap = $('potCaption');
  if(cap) cap.textContent = name==='bamboo' ? 'POT CHINESE PANDA' : 'TIỀN CHIẾU';

  startParticles();
  const btn = $('btnTheme');
  if(btn) btn.title = 'Theme: '+(THEME_LABELS[name]||name);
  try{localStorage.setItem('lieng.theme',name);}catch{}
}

function nextTheme(){
  const i = THEMES.indexOf(currentTheme);
  return THEMES[(i+1)%THEMES.length];
}
function randomTheme(){
  const o = THEMES.filter(t=>t!==currentTheme);
  return o[Math.floor(Math.random()*o.length)]||THEMES[0];
}

function startParticles(){
  if(particleTimer) clearInterval(particleTimer);
  document.querySelectorAll('.particle').forEach(p=>p.remove());
  const box = document.querySelector('.theme-particles');
  if(!box) return;
  particleTimer = setInterval(()=>{
    if(document.hidden) return;
    const p = document.createElement('div');
    p.className = 'particle';
    const dur = 5+Math.random()*6;
    p.style.animationDuration = dur+'s';
    p.style.left = Math.random()*100+'%';
    p.style.top = currentTheme==='vietnam'?(70+Math.random()*30)+'%':'-5%';
    p.style.animationDelay = Math.random()*2+'s';
    box.appendChild(p);
    setTimeout(()=>p.remove(),(dur+3)*1000);
  },900);
}

/* ---- Theme Sounds ---- */
const themeSfx = {
  sakura:{
    lieng(){ [659,784,1046,1318].forEach((f,i)=>tone(f,.3,'sine',.05,i*.1)); },
    sap(){ [523,784,1046,1568,2093].forEach((f,i)=>tone(f,.35,'sine',.06,i*.08)); },
  },
  bamboo:{
    lieng(){ tone(130,.6,'sine',.06);[523,659,784].forEach((f,i)=>tone(f,.25,'triangle',.04,i*.12+.2)); },
    sap(){ tone(98,.8,'sine',.08);[392,523,659,784,1046].forEach((f,i)=>tone(f,.3,'triangle',.05,i*.1+.15)); },
  },
  vietnam:{
    lieng(){ [440,554,659,880].forEach((f,i)=>tone(f,.35,'sine',.05,i*.12)); },
    sap(){ [330,440,554,659,880,1108].forEach((f,i)=>tone(f,.4,'sine',.06,i*.08)); },
  },
};

function applyGlow(playerId, catName){
  const el = document.getElementById('seat-'+playerId);
  if(!el) return;
  let cls = null;
  let labelText = '';
  if(catName && catName.includes('Sáp')) { cls = 'sap-glow'; labelText = '🔥 SÁP 🔥'; }
  else if(catName && catName.includes('Liêng')) { cls = 'lieng-glow'; labelText = '✨ LIÊNG ✨'; }
  if(!cls) return;
  el.classList.add(cls);
  const badge = el.querySelector('.seat-badge-glow');
  if(badge) badge.textContent = labelText;
  const ts = themeSfx[currentTheme];
  if(ts){
    if(cls==='sap-glow'&&ts.sap) ts.sap();
    else if(cls==='lieng-glow'&&ts.lieng) ts.lieng();
  }
  setTimeout(()=>el.classList.remove(cls), cls==='sap-glow'?3200:3600);
}

/* ---- Chat Bubbles ---- */
const EMOJI_LIST = ['👍','😎','🤑','😡','🔥','💰','🎉','😢','❤️','😂'];
const PURE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]{1,5}$/u;
let chatBubbles = [];

function showChatBubble(fromName, text){
  const player = ui.state?.players?.find(p=>p.name===fromName);
  if(!player) return;
  const seatEl = document.getElementById('seat-'+player.id);
  const felt = $('felt');
  if(!seatEl||!felt) return;
  const bubble = document.createElement('div');
  const isEmoji = PURE_EMOJI.test(text.trim());
  bubble.className = 'chat-bubble'+(isEmoji?' emoji-big':'');
  bubble.textContent = text;
  const sL = parseFloat(seatEl.style.left)||50;
  const sT = parseFloat(seatEl.style.top)||50;
  bubble.style.left = sL+'%';
  bubble.style.top = Math.max(5,sT-12)+'%';
  bubble.style.transform = 'translate(-50%,-100%)';
  felt.appendChild(bubble);
  chatBubbles.push(bubble);
  setTimeout(()=>{
    bubble.classList.add('fade-out');
    setTimeout(()=>{bubble.remove();chatBubbles=chatBubbles.filter(b=>b!==bubble);},500);
  },isEmoji?3000:5000);
  while(chatBubbles.length>6){const old=chatBubbles.shift();old.remove();}
}

let unreadChat = 0;
function updateChatBadge(){
  const btn = $('btnChat');
  if(!btn) return;
  let badge = btn.querySelector('.badge');
  if(unreadChat>0&&!$('panelChat')?.classList.contains('show')){
    if(!badge){badge=document.createElement('span');badge.className='badge';btn.appendChild(badge);}
    badge.textContent = unreadChat>9?'9+':unreadChat;
  } else {
    if(badge) badge.remove();
    unreadChat = 0;
  }
}

function initEmojiBar(){
  const bar = document.querySelector('.emoji-bar');
  if(!bar) return;
  bar.innerHTML = EMOJI_LIST.map(e=>`<button title="${e}">${e}</button>`).join('');
  bar.querySelectorAll('button').forEach(b=>{
    b.onclick = ()=>{ sendRaw({t:'chat',text:b.textContent}); };
  });
}

$('btnTheme').onclick = ()=>{
  setTheme(nextTheme());
  toast('Theme: '+(THEME_LABELS[currentTheme]||currentTheme));
};

/* ================= KHỞI ĐỘNG ================= */
(function boot(){
  setAuthMode('login');
  let luuAutoFlip = null;
  try{ luuAutoFlip = localStorage.getItem('lieng.autoflip'); }catch{}
  setAutoFlip(luuAutoFlip === '1');

  // Initialize theme
  let savedTheme = null;
  try{ savedTheme = localStorage.getItem('lieng.theme'); }catch{}
  setTheme(savedTheme && THEMES.includes(savedTheme) ? savedTheme : THEMES[Math.floor(Math.random()*THEMES.length)]);
  initEmojiBar();

  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})/);
  const urlCode = m ? m[1].toUpperCase() : null;
  if(urlCode){
    $('inpCode').value = urlCode;
    $('privBody').classList.add('show');
  }

  let sessionToken = null;
  let seat = null;
  try{
    sessionToken = localStorage.getItem(SESSION_KEY);
    seat = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  }catch{}

  if(!sessionToken) return; // chưa đăng nhập bao giờ -> ở màn đăng nhập

  ui.sessionToken = sessionToken;
  connect(() => {
    sendRaw({t:'auth', sessionToken});
    // Đang dở một ván ở phòng riêng thì thử ngồi lại ghế cũ
    if(seat?.token && (!urlCode || seat.code === urlCode)){
      ui.code = seat.code;
      ui.token = seat.token;
      sendRaw({t:'resume', code: seat.code, token: seat.token});
      setTimeout(() => {
        if(!ui.playerId && !ui.spectating){
          ui.code = null; ui.token = null;
          try{ localStorage.removeItem(STORE_KEY); }catch{}
        }
      }, 2500);
    }
  });
})();

})();
