// ==========================================
//  KP銃ゲー オンライン対戦サーバー（ver.18 ＋ 飛行機の同期つき）
//   ★今回の変更は「飛行機」だけです（ほかの動きは、今のサーバーと同じ）
//    ・飛行機の最後の状態をサーバーが覚える → あとから入ってきた人にも、止まっている飛行機が見える
//    ・飛行機を片づけた／持ち主が抜けた時は、覚えていた状態も消す
//    ・誰もいなくなったら、飛行機の記憶もぜんぶ消す
//   ※ 前までの長い説明コメント（server11〜15 の履歴）は、短くしました。動きには関係ありません
//   ※ ゲーム側（main.js）にも、飛行機の同期のコード（fx23b）が要ります（別に渡したもの） 
//
//  これまでの主な機能：ブロック・壊れる建物の共有／ドロップアイテム／ゴッドライフル／Botの武器／宝箱／台座・地雷／
//   通信量の削減（位置は「ゲームに入っている人」にだけ）／Owner専用 /kick・BAN杖／本人確認つきの参加／ダメージの不正対策
// ==========================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 3 }, concurrencyLimit: 10 }   // ★256バイト以上の知らせは圧縮して送る（通信量が 1/4〜1/8 ほどに）
});

app.get('/', (req, res) => res.send('KP銃ゲー オンラインサーバー 稼働中です（ver.18・飛行機同期つき）'));

const SERVER_VERSION = 16;

// ---------- ★ver.16：Owner だけが使える /kick と BAN杖（ほんとうの確認は、サーバー＋GAS がします） ----------
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxzgDW5fnSzU0Y_umyxHmbkw3zWkyR5mcBE-ALiS7urpqoQ9sLewMp7F4iBuPzOutQ/exec';   // ★★ここに、GAS の「ウェブアプリのURL」（ゲームの画面が使っているのと同じもの）を入れてください。空のままだと、/kick も BAN杖も、だれも使えません（安全側）
const FX_BAN_SHOW_MS = 4000;          // BANの演出：相手の上にテレポートしてから、落ちてくるまで待つ時間(ms)
const fxOwnerCache = new Map();   // 'ID' → { owner, at }（同じ人を何度もGASに聞かないための記憶。30秒）
const fxPlaneSids = new Set();         // 飛行機を出している人（ほかの人に、飛行機の形を見せるため）
const fxPlaneLast = new Map();         // ★飛行機の最後の状態：socket.id → 配った内容（あとから入った人に、止まっている飛行機も見せるため）
function fxNum(v, lim) { v = Number(v); return Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0; }
let fxBanBusyUntil = 0;               // BANの演出は、同時に1つだけ
async function fxGasPost(obj) {
  if (!GAS_URL || typeof fetch !== 'function') return null;
  const ac = (typeof AbortController === 'function') ? new AbortController() : null;
  const tm = ac ? setTimeout(() => { try { ac.abort(); } catch (e) {} }, 12000) : null;
  try {
    const r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(obj), redirect: 'follow', signal: ac ? ac.signal : undefined });
    return await r.json();
  } catch (e) { console.error('[GAS]', e && e.message); return null; }
  finally { if (tm) clearTimeout(tm); }
}
// ★ver.17：本人確認（GAS に「そのIDは登録済みか・BANされていないか・正しい名前は何か」を聞く）
const FX_BAD_NAMES = ['プレイヤー', 'ユーザー', 'ゲスト', 'player', 'user', 'guest', '???'];   // GAS が古くて確認できない時だけ使う
async function fxIdentity(deviceId, fresh) {
  const id = String(deviceId || '').trim();
  if (!id || !GAS_URL) return null;
  const c = fxOwnerCache.get(id), now = Date.now();
  if (c && c.info && now - c.at < 30000 && !(fresh && c.info.owner)) return c.info;
  const j = await fxGasPost({ action: 'fpsOwnerCheck', id: id });
  if (!j || j.status !== 'success') return null;   // 聞けなかった時は記憶しない
  const info = { verified: typeof j.exists === 'boolean', owner: j.owner === true, exists: j.exists === true, name: String(j.name || ''), banned: j.banned === true, banReason: String(j.banReason || '') };
  fxOwnerCache.set(id, { info: info, at: now });
  return info;
}
async function fxIsOwnerId(deviceId, fresh) { const i = await fxIdentity(deviceId, fresh); return !!(i && i.owner); }

const players = {};
// ---------- ★ver.14：通信量を減らす道具 ----------
const GAME_ROOM = 'fpsGame';            // ゲームに入っている人だけの「部屋」。位置の知らせは、この部屋の人にだけ送る（チャット用の接続には送らない）
const BCAST_KEEPALIVE_MS = 3000;        // 前回と同じ内容の時は、この間隔(ms)に1回だけ送る（動いている間は、0.1秒ごとのまま）
const HIDE_KEYS = { velX: 1, velZ: 1, lastUpdateT: 1, lastGodHitAt: 1, lastDeath: 1, rate: 1, id: 1, owner: 1, banLock: 1, vio: 1, lastAct: 1, lastHitBy: 1 };  // ★id（アカウントのID）を、みんなに配らないように（IDが見えると、なりすまされるため）   // サーバーの中だけで使う項目（みんなには送らない）
const round2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);      // 1cm 単位
const round3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);    // 向きは 0.001 単位
function publicPlayers() {   // みんなに送る形（中身は players と同じで、内部用の項目を外し、数字を丸めたもの）
  const out = {};
  for (const sid of Object.keys(players)) {
    const p = players[sid], o = {};
    for (const k of Object.keys(p)) { if (!HIDE_KEYS[k]) o[k] = p[k]; }
    o.x = round2(p.x); o.y = round2(p.y); o.z = round2(p.z); o.yaw = round3(p.yaw); o.pitch = round3(p.pitch); o.health = round2(p.health);
    out[sid] = o;
  }
  return out;
}
function publicBots() { return bots.filter(b => b.health > 0).map(b => ({ id: b.id, x: round2(b.x), y: round2(b.y), z: round2(b.z), weaponId: b.weaponId })); }
const BOT_COUNT = 4;              //オンラインのbotの数
const BOT_BULLET_MUL = 1.7;      // ★クライアントの FX18_SPEED_ALL（全体の弾の速さの倍率）と同じ数字にしてください（見た目と当たる速さがそろいます）
// ★Botの武器（確率で決まります）。数字を変えると、強さ・出やすさを調整できます
//   w＝出やすさ（重み。合計に対する割合）／gap＝撃つ間隔(ms)／dmg＝1発のダメージ／n＝1回に何発ずつ撃つか／burstGap＝その連射の間隔(ms)
//   spread＝弾のばらつき／speed＝弾の速さ（クライアントの元の数字。上の BOT_BULLET_MUL をかけます）／range＝この距離(m)より遠くは撃たない
//   pellets＝ショットガンの粒の数（近いほど多く当たる）
//   強さの目安：1回に撃つ分の最大ダメージが 12〜15 ほど（昔のBotは 6 を 1.5 秒ごと）。ばらつき・動きで、実際に当たるのは、もっと少なめです
const BOT_GUNS = {
  pistol:   { w: 38, gap: 1500, dmg: 6,  n: 1, burstGap: 0,   spread: 0.05, speed: 55, range: 40 },
  smg:      { w: 20, gap: 2100, dmg: 3,  n: 4, burstGap: 90,  spread: 0.09, speed: 60, range: 28 },
  rifle:    { w: 16, gap: 2200, dmg: 4,  n: 3, burstGap: 110, spread: 0.07, speed: 65, range: 36 },
  shotgun:  { w: 12, gap: 2400, dmg: 3,  n: 1, burstGap: 0,   spread: 0.04, speed: 50, range: 16, pellets: 5 },
  revolver: { w: 9,  gap: 2300, dmg: 11, n: 1, burstGap: 0,   spread: 0.05, speed: 70, range: 36 },
  marksman: { w: 5,  gap: 2800, dmg: 12, n: 1, burstGap: 0,   spread: 0.02, speed: 80, range: 40 }
};
const BOT_GUN_IDS = Object.keys(BOT_GUNS);
function pickBotWeapon() {   // 重みに比べて、くじ引きで1つ決める
  let total = 0;
  for (const id of BOT_GUN_IDS) total += BOT_GUNS[id].w;
  let r = Math.random() * total;
  for (const id of BOT_GUN_IDS) { r -= BOT_GUNS[id].w; if (r < 0) return id; }
  return 'pistol';
}

const FX_STEAL_WINDOW_MS = 20 * 1000;   // 倒してから、この時間の間だけ「武器を奪った」と受け付ける
const FX_SHOT_MAX_PER_SEC = 60;         // 1人が1秒に送れる「撃った知らせ」の数（ミニガン・台座を何台か置いても足りる数）
const BOT_SLOW_MUL = 0.4;        // ★鈍足中のBotの動きの速さ（クライアントの FX18_SLOW_MUL と同じ）
const FX_SLOW_MAX_MS = 10000;    // 鈍足の長さの上限（ズル対策）
const FX_GOD_MAX_DAMAGE = 350;   // ゴッドライフル1発のダメージの上限（ふつうは34、頭で51、攻撃力アップの薬でも約100）
const FX_GOD_MIN_GAP_MS = 150;   // ゴッドライフルの「特別な効果（防具無視・鈍足）」が付く最短の間隔（連射のズル対策。ふつうは260ms以上あきます）
const FIELD_HALF = 225;          // Botや箱が出てくる範囲（元のフィールドの半幅）
const WORLD_HALF = 360;          // 歩ける全体の半幅（⑫-A で外側に広げた分も入れた数字。FX13_EXTRA を変えたら「105＋その数字」にする）
const TOWER_SAFE_Y = 20;
const ONLINE_TOWER = { x: 0, z: 0 };
const SPAWN_Y = 96;              // 参加した直後の高さ（塔のてっぺん）
const NETHER_Y = 900;            // これより上にいる人は「ネザーにいる」
const PLACE_MAX_Y = 130;         // 銃台座・地雷を置ける高さの上限（塔のてっぺんは約92m）

// ---------- ブロック（クライアントの⑲）の決まり ----------
const FX_BLOCK_MAX_TOTAL = 50000;           // ★クライアントの FX19_MAX_PLACED と同じ数字にしてください（ブロックの合計の上限・みんなの分）
const FX_BLOCK_MAX_PER_PLAYER = 1500;      // 1人が同時に置いておける数
const FX_BLOCK_MAX_Y = 120;               // ★クライアントの FX19_MAX_Y と同じ数字に（置ける高さの上限）
const FX_BLOCK_HALF = WORLD_HALF - 2;     // 置ける範囲（マップの半幅 − 2。クライアントと同じ考え方）
const FX_BLOCK_REACH = 14;                // 置く・壊す時に、サーバーが知っているプレイヤーの位置からこの距離(m)まで（通信の遅れの余裕を含む。ふつうの遊び方は6m）
const FX_MAP_RESTORE_MS = 30 * 60 * 1000; // ★クライアントの FX19_RESTORE_MS と同じ数字に（壊した建物が元に戻るまでの時間）
const FX_TOWER_TOP_Y = SPAWN_Y - 2;       // 塔のてっぺんの高さ（この近くの高い所は、ブロックで囲めない）



// ---------- 小さな道具 ----------
function num(v, lo, hi, dflt) {   // 数字として正しければ lo〜hi に収めて返す。変な値は dflt
  v = Number(v);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}
function guard(name, fn) {   // 1つの通信でエラーが出ても、サーバー全体が止まらないようにする
  return function () {
    try { return fn.apply(this, arguments); } catch (e) { console.error('[エラー] ' + name + ':', e && e.message); }
  };
}

// ==========================================
// 🛡️ ★ver.18：ダメージの不正対策（ヒットの知らせを、サーバーが確かめる）
// ==========================================
const FX_HIT_SAFE_R = 10.5, FX_HIT_SAFE_Y = 88;   // 出現の塔（半径9・てっぺん約92m）の上からは、ダメージを出せない（クライアントの「塔を出るまで攻撃できない」と同じ）
const FX_HIT_ORBITAL_RE = /^(nuke[0-9]*|stab|railgun|godrifle)$/;   // 大きなダメージが出てよい武器（別の入れ物で数える）
const FX_ACTION_WINDOW_MS = 45000;   // 「撃った／振った」知らせから、この時間の間だけヒットを受け付ける（0 にすると、この確認をしない）
const FX_VIOLATION_KICK = 12;        // 10秒の間に、おかしな知らせがこの回数に届いた接続は、切る
const FX_TEMPBAN_MS = 10 * 60 * 1000;   // 切られた人が、また入れるようになるまで
const fxTempBan = new Map();         // ID → 入れるようになる時刻
function fxBucket(p, name, cap, perSec, cost) {   // 「使える量」がたまっていく入れ物。足りなければ false
  const now = Date.now();
  if (!p.rate) p.rate = {};
  const r = p.rate[name] || (p.rate[name] = { t: cap, at: now });
  r.t = Math.min(cap, r.t + (now - r.at) / 1000 * perSec); r.at = now;
  if (r.t < cost) return false;
  r.t -= cost;
  return true;
}
function fxInSafeTower(p) { return Math.hypot(p.x - ONLINE_TOWER.x, p.z - ONLINE_TOWER.z) <= FX_HIT_SAFE_R && p.y >= FX_HIT_SAFE_Y; }
function fxHasArmedTurret(sid) {   // ★銃を付けた台座を、いま置いている人か（台座の弾は、持ち主が何もしていなくても当たるため）
  for (const id in fxPlaced) { const o = fxPlaced[id]; if (o.ownerSid === sid && o.kind === 'turret' && o.gun) return true; }
  return false;
}
function fxViolation(socket, p, why) {   // おかしな知らせを数えて、多すぎたら切る（ログに名前が残る）
  const now = Date.now();
  if (!p.vio || now - p.vio.at > 10000) p.vio = { n: 0, at: now };
  p.vio.n++;
  if (p.vio.n === 1 || p.vio.n % 5 === 0) console.warn('[不正？] ' + p.name + ' : ' + why + ' (' + p.vio.n + ')');
  if (p.vio.n >= FX_VIOLATION_KICK) {
    console.warn('[不正？] 切断しました: ' + p.name);
    fxTempBan.set(String(p.id), now + FX_TEMPBAN_MS);
    try { socket.emit('youWereKicked', {}); } catch (e) {}
    setTimeout(() => { try { socket.disconnect(true); } catch (e) {} }, 200);
  }
}

function randomSpot() {
  return { x: (Math.random() - 0.5) * FIELD_HALF * 1.7, z: (Math.random() - 0.5) * FIELD_HALF * 1.7 };
}

const ONLINE_MAP_SEED = 918273645;
function makeSeededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATIC_OBSTACLES = [
  { x: 0, z: 0, hx: 3.2, hz: 3.2 },
  { x: 30, z: 0, hx: 4.8, hz: 4.8 },
  { x: -30, z: 20, hx: 4.8, hz: 4.8 }
];
function resolveBotMove(curX, curZ, desiredX, desiredZ, botY) {
  const y = (typeof botY === 'number') ? botY : 1.3;
  const inside = fxBotBlocked(curX, curZ, y);   // すでにブロックの中に入ってしまっている時は、止めない（抜け出せなくなるのを防ぐ）
  let testX = desiredX;
  for (const ob of STATIC_OBSTACLES) {
    if (testX > ob.x - ob.hx && testX < ob.x + ob.hx && curZ > ob.z - ob.hz && curZ < ob.z + ob.hz) { testX = curX; break; }
  }
  if (!inside && testX !== curX && fxBotBlocked(testX, curZ, y)) testX = curX;   // ★置かれたブロックにぶつかる
  let testZ = desiredZ;
  for (const ob of STATIC_OBSTACLES) {
    if (testX > ob.x - ob.hx && testX < ob.x + ob.hx && testZ > ob.z - ob.hz && testZ < ob.z + ob.hz) { testZ = curZ; break; }
  }
  if (!inside && testZ !== curZ && fxBotBlocked(testX, testZ, y)) testZ = curZ;
  return { x: testX, z: testZ };
}

function generateCrateLayout() {
  const rand = makeSeededRandom(ONLINE_MAP_SEED);
  const H = FIELD_HALF;
  const list = [];
  for (let i = 0; i < 6; i++) {
    let x, z;
    do { x = (rand() - 0.5) * H * 1.7; z = (rand() - 0.5) * H * 1.7; } while (Math.hypot(x - ONLINE_TOWER.x, z - ONLINE_TOWER.z) < 20);
    list.push({ id: 'crate_' + i, x, z, isRare: false, alive: true });
  }
  for (let i = 0; i < 2; i++) {
    let x, z;
    do { x = (rand() - 0.5) * H * 1.7; z = (rand() - 0.5) * H * 1.7; } while (Math.hypot(x - ONLINE_TOWER.x, z - ONLINE_TOWER.z) < 20);
    list.push({ id: 'rare_crate_' + i, x, z, isRare: true, alive: true });
  }
  return list;
}
let onlineCrates = generateCrateLayout();

// ==========================================
// 🤖 Bot（上に吹き飛ばされたら、重力で落ちてくる）
// ==========================================
const BOT_REST_Y = 1.3;          // 地面に立っている時の高さ（クライアントと同じ）
const BOT_GRAV = 22;             // 重力（プレイヤーと同じ）
const BOT_UP_BASE = 3.4;         // 吹き飛ばされた時の上向きの速さ ＝ この数字 ＋ 「横に飛ばした距離(m)」 × BOT_UP_RATIO
const BOT_UP_RATIO = 1.5;        //   （オフラインのBotと同じ数字。TNTで3.5m飛ばされたBotは、約1.7mの高さまで跳ね上がります）
const BOT_UP_MAX = 11;
const BOT_KB_MAX = 15;           // 1回の横の吹き飛ばしの上限（ズル対策）
const bots = [];
function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const p = randomSpot();
    bots.push({ id: 'bot_' + i, x: p.x, y: BOT_REST_Y, vy: 0, z: p.z, targetX: p.x, targetZ: p.z, health: 100, weaponId: pickBotWeapon(), lastShot: 0, stunnedUntil: 0, slowUntil: 0 });
  }
}
initBots();
function respawnBotLater(bot) {
  setTimeout(() => {
    const p = randomSpot();
    bot.health = 100; bot.x = p.x; bot.z = p.z; bot.y = BOT_REST_Y; bot.vy = 0; bot.stunnedUntil = 0; bot.slowUntil = 0;
    bot.weaponId = pickBotWeapon();   // ★復活のたびに、くじ引きで武器が変わる
  }, 6000);
}
function clampBotToWorld(bot) {
  const lim = WORLD_HALF - 3;
  bot.x = Math.max(-lim, Math.min(lim, bot.x));
  bot.z = Math.max(-lim, Math.min(lim, bot.z));
}

const chatOnlineUsers = {};

// ==========================================
// 🌺 ハワイの宝箱（取り合いの管理）／防具の共有
// ==========================================
const FX_CHEST_COUNT = 4;              // ★クライアントの宝箱の数（オンラインは4個）と同じにしてください
const FX_CHEST_RESPAWN_MS = 90000;     // ★開けたあと、また閉まるまでの時間（ミリ秒）
const fxChests = [];
for (let i = 0; i < FX_CHEST_COUNT; i++) fxChests.push({ open: false, reopenAt: 0 });
function fxOpenChestIds() {
  const ids = [];
  fxChests.forEach((c, i) => { if (c.open) ids.push(i); });
  return ids;
}

// ==========================================
// 🔥 ネザーの宝箱（全員で同じ箱を取り合う）
// ==========================================
// 箱の番号と場所は、ネザーを作る⑫-B が決めた順番（0番から）です。みんな同じネザーなので、番号も同じになります
const FX_NCHEST_COUNT = 22;                // ★ネザーの箱の数（⑫-B が作る数）と同じにしてください
const FX_NCHEST_RARE = [0, 1, 2, 3];       // ★レアチェストの番号（ピラミッドのてっぺん×3・要塞の中央）
const FX_NCHEST_RESPAWN_MS = 150000;       // ふつうの箱：開けてから、また閉まるまで
const FX_NCHEST_RARE_RESPAWN_MS = 300000;  // レアチェスト
const fxNChests = [];
for (let i = 0; i < FX_NCHEST_COUNT; i++) fxNChests.push({ open: false, reopenAt: 0, rare: FX_NCHEST_RARE.indexOf(i) >= 0 });
function fxNChestList() {   // いま開いている箱：[[番号, また閉まるまでの残りミリ秒], ...]
  const now = Date.now(), out = [];
  fxNChests.forEach((c, i) => { if (c.open) out.push([i, Math.max(0, c.reopenAt - now)]); });
  return out;
}

setInterval(() => {   // 1秒ごとに、時間がたった箱を閉める／30分たった建物を元に戻す
  const now = Date.now();
  let changed = false, nChanged = false;
  fxChests.forEach((c) => { if (c.open && now >= c.reopenAt) { c.open = false; changed = true; } });
  fxNChests.forEach((c) => { if (c.open && now >= c.reopenAt) { c.open = false; nChanged = true; } });
  if (changed) io.emit('fxChestState', { open: fxOpenChestIds() });
  if (nChanged) io.emit('fxNChestState', { open: fxNChestList() });
  if (fxMapBroken.size) {   // ★壊れたマップの建物：時間がたったものを、全員の画面で元に戻す
    const back = [];
    fxMapBroken.forEach((at, key) => { if (now >= at) back.push(key); });
    if (back.length) {
      back.forEach((k) => fxMapBroken.delete(k));
      io.emit('fxMapRestored', { keys: back });
    }
  }
}, 1000);

// ==========================================
// 🛠️ 設置物（銃台座・地雷）の管理
// ==========================================
const FX_MAX_MINES = 6;            // ★クライアントの数字（FX_MAX_MINES）と同じにしてください
const FX_MAX_TURRETS = 2;          // ★クライアントの数字（FX_MAX_TURRETS）と同じにしてください
const FX_TURRET_HP = 200;          // ★クライアントの数字（FX_TURRET_HP）と同じにしてください
const FX_MAX_HIT_PER_SHOT = 120;   // 1回のダメージの上限（ズル対策）
const fxPlaced = {};               // いま置かれている物（id → 設置物）
let fxPlacedSeq = 0;
function fxPlacedInfo(o) { return { id: o.id, kind: o.kind, ownerId: o.ownerSid, ownerName: o.ownerName, x: o.x, y: o.y, z: o.z, hp: o.hp, gun: o.gun }; }
function fxPlacedOwnedCount(sid, kind) { let n = 0; for (const id in fxPlaced) { if (fxPlaced[id].ownerSid === sid && fxPlaced[id].kind === kind) n++; } return n; }

function isOrbitalType(t) {   // nuke ＝ レベル2（今までの強さ）／nuke1・nuke3・nuke5・nuke10 … ＝ レベル指定（nuke1〜nuke999）
  return t === 'nuke' || t === 'stab' || t === 'railgun' || /^nuke[1-9][0-9]{0,2}$/.test(t);
}

// ==========================================
// 🧱 ブロック（置く・壊す）／壊したマップの部品（30分で元に戻る）
// ==========================================
// ブロックは 1m の升目（整数の x, y, z）に1個。マップの部品は、クライアントが付けた名前（キー）で数えます
const FX_BLOCK_KIND_RE = /^[a-z0-9_]{1,16}$/;                                        // ブロックの種類の名前（クライアントが種類を増やしても、サーバーはそのまま使えます）
const FX_MAP_KEY_RE = /^m-?\d{1,5},-?\d{1,4},-?\d{1,5}:\d{1,4},\d{1,4},\d{1,4}$/;   // マップの部品の名前（例 m-1500,25,300:60,50,60）
const fxBlocks = new Map();        // 置かれているブロック：'x,y,z' → { x, y, z, kind, owner, ownerName }
const fxBlockOwned = {};           // 持ち主（deviceId）→ いま置いている数
const fxMapBroken = new Map();     // 壊れているマップの部品：キー → 元に戻る時刻(ms)

function fxKeyOf(x, y, z) { return x + ',' + y + ',' + z; }
function fxCell(d) {   // { x, y, z } がぜんぶ整数なら [x, y, z]、そうでなければ null
  if (!d || typeof d !== 'object') return null;
  if (!Number.isInteger(d.x) || !Number.isInteger(d.y) || !Number.isInteger(d.z)) return null;
  return [d.x, d.y, d.z];
}
function fxParseKey(s) {   // 'x,y,z' → [x, y, z]（形が正しくなければ null）
  if (typeof s !== 'string' || s.length > 24) return null;
  const m = /^(-?\d{1,4}),(-?\d{1,4}),(-?\d{1,4})$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function fxMapKeyInfo(k) {   // マップの部品の名前 → 中心(m)と大きさ(m)。形が正しくなければ null
  if (typeof k !== 'string' || k.length > 44 || !FX_MAP_KEY_RE.test(k)) return null;
  const m = /^m(-?\d+),(-?\d+),(-?\d+):(\d+),(\d+),(\d+)$/.exec(k);
  if (!m) return null;
  return { x: Number(m[1]) / 10, y: Number(m[2]) / 10, z: Number(m[3]) / 10, size: Math.max(Number(m[4]), Number(m[5]), Number(m[6])) / 10 };
}
function fxRate(p, name, perSec, burst) {   // 連打のズル対策：1秒に perSec 回まで（最初の burst 回はまとめてOK）
  const now = Date.now();
  if (!p.rate) p.rate = {};
  const r = p.rate[name] || (p.rate[name] = { t: burst, at: now });
  r.t = Math.min(burst, r.t + (now - r.at) / 1000 * perSec); r.at = now;
  if (r.t < 1) return false;
  r.t -= 1;
  return true;
}
function fxOwnerKey(p, sid) { return String((p && p.id) || sid); }
function fxNear(p, x, y, z, reach) {   // サーバーが知っているプレイヤーの位置から、reach(m) 以内か
  return Math.hypot(p.x - x, p.z - z) <= reach && Math.abs(p.y - y) <= reach;
}
function fxBodyHits(x, y, z, exceptSid) {   // 置こうとする升目に、ほかのプレイヤー・Botの体が入っていないか（自分の分は、クライアントが細かく確かめます）
  const ov = function (px, py0, py1, pz, hw) {
    return px + hw > x + 0.001 && px - hw < x + 1 - 0.001 && pz + hw > z + 0.001 && pz - hw < z + 1 - 0.001 && py1 > y + 0.001 && py0 < y + 1 - 0.001;
  };
  for (const sid of Object.keys(players)) {
    if (sid === exceptSid) continue;
    const q = players[sid];
    if (ov(q.x, q.y - 1.0, q.y + 1.1, q.z, 0.5)) return true;
  }
  for (const b of bots) { if (b.health > 0 && ov(b.x, b.y - 1.0, b.y + 1.1, b.z, 0.5)) return true; }
  return false;
}
function fxPlaceWhyNot(p, sid, x, y, z) {   // 置けない理由の文（置けるなら ''）
  if (p.y >= NETHER_Y) return 'ネザーではブロックを使えません';
  if (x < -FX_BLOCK_HALF || x + 1 > FX_BLOCK_HALF || z < -FX_BLOCK_HALF || z + 1 > FX_BLOCK_HALF) return 'マップの端には置けません';
  if (y < 0) return '地面より下には置けません';
  if (y > FX_BLOCK_MAX_Y) return 'これより高くは置けません';
  if (!fxNear(p, x + 0.5, y + 0.5, z + 0.5, FX_BLOCK_REACH)) return '遠すぎます。近づいてください';
  if (fxBlocks.has(fxKeyOf(x, y, z))) return 'そこには、もうブロックがあります';
  if (fxBlocks.size >= FX_BLOCK_MAX_TOTAL) return 'ブロックは、みんなで合計 ' + FX_BLOCK_MAX_TOTAL + ' 個までです（壊して回収しよう）';
  if ((fxBlockOwned[fxOwnerKey(p, sid)] || 0) >= FX_BLOCK_MAX_PER_PLAYER) return 'あなたが置いておけるブロックは ' + FX_BLOCK_MAX_PER_PLAYER + ' 個までです';
  if (Math.abs(x + 0.5 - ONLINE_TOWER.x) < 14 && Math.abs(z + 0.5 - ONLINE_TOWER.z) < 14 && y > FX_TOWER_TOP_Y - 6) return '塔のまわりの高い所には置けません';
  if (fxBodyHits(x, y, z, sid)) return '誰かの体と重なる場所には置けません';
  return '';
}
function fxBlockAddNow(sid, p, x, y, z, kind) {
  const owner = fxOwnerKey(p, sid);
  const b = { x: x, y: y, z: z, kind: kind, owner: owner, ownerName: String(p.name || 'プレイヤー').slice(0, 24) };
  fxBlocks.set(fxKeyOf(x, y, z), b);
  fxBlockOwned[owner] = (fxBlockOwned[owner] || 0) + 1;
  return b;
}
function fxBlockRemoveKey(key) {   // 1個消す（消せたら true）
  const b = fxBlocks.get(key);
  if (!b) return false;
  fxBlocks.delete(key);
  const n = (fxBlockOwned[b.owner] || 1) - 1;
  if (n > 0) fxBlockOwned[b.owner] = n; else delete fxBlockOwned[b.owner];
  return true;
}
function fxBlockSnapshot() {   // いまの全部（参加した人・つなぎ直した人に送る）
  const now = Date.now(), list = [], broken = [];
  fxBlocks.forEach((b) => { list.push([b.x, b.y, b.z, b.kind]); });
  fxMapBroken.forEach((at, key) => { broken.push([key, Math.max(0, at - now)]); });
  return { list: list, broken: broken, restoreMs: FX_MAP_RESTORE_MS };
}
function fxMapBreakKeys(keys) {   // 壊れた建物として記録する。新しく壊れた分のキーだけを返す
  const out = [], at = Date.now() + FX_MAP_RESTORE_MS;
  keys.forEach((k) => { if (!fxMapBroken.has(k)) { fxMapBroken.set(k, at); out.push(k); } });
  return out;
}
function fxBlocksResetAll() {   // 誰もいなくなったら、ブロックも壊れた建物も、はじめの状態に戻す
  fxBlocks.clear();
  for (const k of Object.keys(fxBlockOwned)) delete fxBlockOwned[k];
  fxMapBroken.clear();
}
function fxBotBlocked(x, z, y) {   // その場所（Botの体の大きさ）に、ブロックが重なっているか
  if (!fxBlocks.size) return false;
  const y0 = Math.floor(y - 1.0), y1 = Math.floor(y + 1.1), r = 0.45;
  const xs = [Math.floor(x - r), Math.floor(x + r)], zs = [Math.floor(z - r), Math.floor(z + r)];
  for (const cx of xs) for (const cz of zs) for (let cy = y0; cy <= y1; cy++) { if (fxBlocks.has(fxKeyOf(cx, cy, cz))) return true; }
  return false;
}
function fxLineBlocked(ax, ay, az, bx, by, bz) {   // 2点の間（弾の通り道）に、ブロックがあるか
  if (!fxBlocks.size) return false;
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const n = Math.min(200, Math.ceil(len / 0.4));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (fxBlocks.has(fxKeyOf(Math.floor(ax + dx * t), Math.floor(ay + dy * t), Math.floor(az + dz * t)))) return true;
  }
  return false;
}

// ---------- ★ver.15：ドロップアイテム（地面に落ちている物。ゲームに入っている全員の画面に出る） ----------
const FX_DROP_LIFETIME_MS = 150 * 1000;   // 落ちている時間（★クライアントの FX21_LIFETIME_S と同じ数字に）
const FX_DROP_MAX = 400;                  // 地面に落ちていられる合計（超えたら古い物から消える）
const FX_DROP_PER_EVENT = 60;             // 1回の知らせで落とせる数
const FX_DROP_PICK_REACH = 8;             // 拾う時：サーバーが知っている位置から、この距離(m)まで（通信の遅れの余裕を含む）
const FX_DROP_ID_RE = /^[a-z0-9_]{1,32}$/;
const FX_DROP_DENY_RE = /^(banrod|godrifle|kami_.*)$/;   // 落とし物にできない物
const fxDrops = new Map();                // 番号 → 落とし物
let fxDropSeq = 0;
function fxDropPublic(r) { return { did: r.did, k: r.k, id: r.id, n: r.n, am: r.am, at: r.at, x: r.x, y: r.y, z: r.z, s: r.s, src: r.src, rare: r.rare }; }
function fxDropClean(d, src, sid) {   // クライアントから来た落とし物を点検して、正しい形にする（変なものは null）
  if (!d || typeof d !== 'object') return null;
  const k = String(d.k || ''), id = String(d.id || '');
  if (k !== 'w' && k !== 'i' && k !== 'a' && k !== 'm') return null;
  if (!FX_DROP_ID_RE.test(id)) return null;
    if (FX_DROP_DENY_RE.test(id)) return null;
  const x = Number(d.x), y = Number(d.y), z = Number(d.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > 1000 || Math.abs(z) > 1000 || y < -60 || y > NETHER_Y + 300) return null;
  return {
    did: 0, k: k, id: id, n: Math.round(num(d.n, 1, 99, 1)), am: Math.round(num(d.am, 0, 9999, 0)), at: d.at === 'omni' ? 'omni' : '',
    x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100, s: sid, src: src, rare: d.rare ? 1 : 0, born: Date.now()
  };
}
function fxDropMakeRoom(n) {   // 入りきらない時は、古い物から消す
  const gone = [];
  while (fxDrops.size + n > FX_DROP_MAX && fxDrops.size > 0) { const first = fxDrops.keys().next().value; fxDrops.delete(first); gone.push(first); }
  if (gone.length) io.to(GAME_ROOM).emit('fxDropGone', { ids: gone });
}

// ---------- ★線路とトロッコ（クライアントの fxrail と組み合わせて使います） ----------
const FXR_MAX_RAILS = 3000, FXR_MAX_RAILS_PER = 400, FXR_MAX_CARTS = 30, FXR_MAX_CARTS_PER = 3;
const fxRails = new Map();        // 'x,y,z' → { x, y, z, ax, owner }
const fxRailOwned = {};           // 持ち主ID → いま置いている線路の数
const fxCarts = new Map();        // id → { id, x, y, z, dx, dz, sp, rider, owner }
let fxCartSeq = 0;
function fxCartInfo(c) { return { id: c.id, x: c.x, y: c.y, z: c.z, dx: c.dx, dz: c.dz, sp: c.sp, rider: c.rider }; }
function fxrSnapshot() {
  const list = [], carts = [];
  fxRails.forEach((r) => { list.push([r.x, r.y, r.z, r.ax]); });
  fxCarts.forEach((c) => { carts.push(fxCartInfo(c)); });
  return { list: list, carts: carts };
}
function fxrResetAll() { fxRails.clear(); fxCarts.clear(); for (const k of Object.keys(fxRailOwned)) delete fxRailOwned[k]; }
function fxrFreeRider(sid) {   // この人が乗っているトロッコを、空きにする 
  fxCarts.forEach((c) => { if (c.rider === sid) { c.rider = null; c.sp = 0; io.to(GAME_ROOM).emit('fxrCartRider', { id: c.id, rider: null }); } });
}

const FX_PRE_JOIN_OK = { join: 1, disconnect: 1, fxOwnerAsk: 1, chatJoin: 1, dmMessage: 1, groupMessage: 1, fxChestSync: 1, fxNChestSync: 1, fxPlacedSync: 1, fxBlockSync: 1, fxrSync: 1, };   // 本人確認の前でも使えるもの（チャット専用の接続・読むだけの同期）

io.on('connection', (socket) => {
  const on = function (ev, fn) {
    socket.on(ev, guard(ev, function () {
      if (!FX_PRE_JOIN_OK[ev] && !players[socket.id]) return;   // ★ゲームに入っていない（本人確認が済んでいない）接続は、何もできない
      return fn.apply(this, arguments);
    }));
  };

  // 「新しいサーバーです」と知らせる（クライアントは、これが届いた時だけ、新しい機能を使います）
  socket.emit('fxServerInfo', { v: SERVER_VERSION, nChests: FX_NCHEST_COUNT, blocks: true, blockMax: FX_BLOCK_MAX_TOTAL, restoreMs: FX_MAP_RESTORE_MS, drops: true });   // blocks＝ブロック対応／drops＝ドロップアイテム対応

  async function fxOwnerRefresh(fresh) {   // いまこの接続の人が Owner かを、GASで確かめて、本人に知らせる
    const p = players[socket.id];
    if (!p) return false;
    const ok = await fxIsOwnerId(p.id, fresh);
    const q = players[socket.id];
    if (q) q.owner = ok;
    socket.emit('fxOwner', { owner: ok });
    return ok;
  }
  on('fxOwnerAsk', () => { fxOwnerRefresh(false).catch(() => {}); });

  let joining = false, joinTries = 0;
  on('join', (d) => {
    if (players[socket.id] || joining) return;
    if (++joinTries > 8) return;   // 何度も入りなおそうとする接続は無視
    const rawId = (d && typeof d.deviceId === 'string') ? d.deviceId.trim() : '';
    const rawName = String((d && d.name) || '').trim();
    const deny = (why, msg) => { joining = false; socket.emit('fxJoinDenied', { why: why, msg: msg }); };
    if (rawId.length < 8 || rawId.length > 80 || rawId === socket.id) { deny('noid', 'アカウント情報の読み込みが終わっていません。少し待ってから、もう一度入ってください'); return; }
    if (!rawName) { deny('noname', '名前の読み込みが終わっていません。少し待ってから、もう一度入ってください'); return; }
    const tb = fxTempBan.get(rawId);
    if (tb && tb > Date.now()) { deny('banned', '不正の疑いで、しばらく入れません（あと約' + Math.ceil((tb - Date.now()) / 60000) + '分）'); return; }
    joining = true;
    (async () => {
      let name = rawName.slice(0, 24);
      let info = null;
      if (GAS_URL) {
        info = await fxIdentity(rawId, false);
        if (!socket.connected) { joining = false; return; }
        if (!info) { deny('busy', '本人確認のサーバーにつながりません'); return; }
      }
      if (info && info.verified) {
        if (!info.exists) { deny('unregistered', 'このアカウントは登録されていません。トップ画面で登録してから入ってください'); return; }
        if (info.banned) { deny('banned', 'このアカウントは利用が制限されています' + (info.banReason ? '（' + info.banReason + '）' : '')); return; }
        if (!info.name) { deny('noname', 'アカウントの名前を確認できません'); return; }
        name = info.name.slice(0, 24);   // ★名前は、登録されている名前を使う（画面から送られた名前は使わない）
      } else if (FX_BAD_NAMES.indexOf(name.toLowerCase()) >= 0) { deny('noname', '名前が読み込まれていません'); return; }
      if (players[socket.id] || !socket.connected) { joining = false; return; }
      joining = false;
      const dups = Object.keys(players).filter((s) => players[s].id === rawId && s !== socket.id);   // ★同じアカウントで前から入っている接続（あとで切る）
      players[socket.id] = {
        id: rawId,
        name: name,
        x: ONLINE_TOWER.x, y: SPAWN_Y, z: ONLINE_TOWER.z, yaw: 0, pitch: 0,
        weaponId: 'pistol', health: 100, armor: '0,0,0,0', costume: '', crouching: false,
        velX: 0, velZ: 0, lastUpdateT: 0, lastGodHitAt: 0
      };
      console.log('参加:', name);
            dups.forEach((s) => { io.to(s).emit('youWereKicked', {}); const old = io.sockets.sockets.get(s); if (old) old.disconnect(true); });   // ★前にいた人を、新しい人を入れたあとで切る
      socket.join(GAME_ROOM);
      fxOwnerRefresh(false).catch(() => {});   // さっきの確認の記憶を使うので、GASにはもう聞かない
      socket.emit('crateUpdate', onlineCrates);
      socket.emit('playersUpdate', publicPlayers());
      socket.emit('botsUpdate', publicBots());
      if (fxDrops.size) socket.emit('fxDropList', { list: Array.from(fxDrops.values()).map(fxDropPublic) });
      fxPlaneLast.forEach((pay, psid) => { if (psid !== socket.id && players[psid]) socket.emit('plRemote', pay); });   // ★いま出ている飛行機（止まっているものも）を、入ってきた人に教える
    })().catch((e) => { console.error('[join]', e && e.message); deny('busy', '本人確認でエラーが出ました'); });
  });

        socket.emit('fxrList', fxrSnapshot());

  on('updateState', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
    if (p.banLock && Date.now() < p.banLock) { p.pitch = num(d.pitch, -1.6, 1.6, 0); return; }   // ★演出中は位置は変えない。見上げる向きだけは、ほかの人にも見せる   // ★BANの演出中の人は、動かせない（位置を変えない）
    const x = Number(d.x), y = Number(d.y), z = Number(d.z), yaw = Number(d.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;   // おかしな数字は無視
    const now = Date.now();
    if (p.lastUpdateT) {
      const dtSec = Math.max(0.02, (now - p.lastUpdateT) / 1000);
      p.velX = (x - p.x) / dtSec;
      p.velZ = (z - p.z) / dtSec;
    }
    p.lastUpdateT = now;
    p.x = x; p.y = y; p.z = z; p.yaw = yaw;
    p.pitch = num(d.pitch, -1.6, 1.6, 0);            // ★上下の向き（頭・武器が上を向く）
    p.crouching = !!d.crouching;                      // ★しゃがみ（他の人の画面でもしゃがむ）
    p.weaponId = String(d.weaponId || 'pistol').slice(0, 30);
    p.health = num(d.health, -1000, 1000, p.health);
    p.isGliding = !!d.isGliding; p.isParachuting = !!d.isParachuting;
  });

  let shotWinAt = 0, shotWinN = 0;
  on('shotFired', (d) => {
    if (!d || typeof d !== 'object') return;
    const t = Date.now();
    if (t - shotWinAt >= 1000) { shotWinAt = t; shotWinN = 0; }
    if (++shotWinN > FX_SHOT_MAX_PER_SEC) return;   // 連打しすぎ
    if (Object.keys(d).length > 40) return;         // 項目が多すぎるものは、変な知らせ
    const pa = players[socket.id]; if (pa) pa.lastAct = t;
    socket.to(GAME_ROOM).emit('remoteShotFired', Object.assign({}, d, { id: socket.id }));   // ★撃った人のID（神器の「撃つ動き」を、その人の人形に出すため）
  });

  on('hitPlayer', (d) => {
    const attacker = players[socket.id];
    if (!attacker || !d || typeof d !== 'object') return;
    const tsid = String(d.targetId || '');
    const target = players[tsid];
    if (!target || tsid === socket.id) { fxViolation(socket, attacker, 'ゲームにいない相手・自分への hitPlayer'); return; }
    if (!(attacker.health > 0) || fxInSafeTower(attacker)) return;   // やられている人・出現の塔の上の人は、ダメージを出せない
    const now = Date.now();
    const viaT = !!d.viaTurret && fxHasArmedTurret(socket.id);   // ★本当に「銃つきの台座」を持っている人の、台座の弾だけ
    if (!viaT && FX_ACTION_WINDOW_MS > 0 && now - (attacker.lastAct || 0) > FX_ACTION_WINDOW_MS) { fxViolation(socket, attacker, '撃っても振ってもいないのにダメージ'); return; }
    const orbital = FX_HIT_ORBITAL_RE.test(String(d.weaponId || '').slice(0, 30));
    const dmg = num(d.damage, 0, 250, 0);
    if (!fxBucket(attacker, 'hitN', 60, 40, 1)) { fxViolation(socket, attacker, 'ヒットの数が多すぎる'); return; }
    if (dmg > 0 && !(orbital ? fxBucket(attacker, 'dmgO', 4000, 150, dmg) : fxBucket(attacker, 'dmgN', 900, 500, dmg))) { fxViolation(socket, attacker, 'ダメージの合計が多すぎる'); return; }
    const payload = { damage: dmg, attackerName: attacker.name + (viaT ? 'のタレット' : ''), attackerId: socket.id };
    if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      payload.kbX = num(d.kbX, -1.5, 1.5, 0); payload.kbZ = num(d.kbZ, -1.5, 1.5, 0);
      payload.kbForce = num(d.kbForce, 0, 30, 6); payload.kbVertical = !!d.kbVertical;
    }
    if (d.stunMs) payload.stunMs = num(d.stunMs, 0, 6000, 0);
    if (d.weaponId === 'godrifle') {   // ★ゴッドライフル：防具無視（pierce）と鈍足（slowMs）
      const nowG = Date.now();
      if (nowG - (attacker.lastGodHitAt || 0) >= FX_GOD_MIN_GAP_MS) {
        attacker.lastGodHitAt = nowG;
        if (d.pierce === true) payload.pierce = true;
        const slow = num(d.slowMs, 0, FX_SLOW_MAX_MS, 0);
        if (slow > 0) payload.slowMs = slow;
      }
    }
    target.lastHitBy = { sid: socket.id, at: now };   // 「だれに倒されたか」の確認に使う
    io.to(tsid).emit('youWereHit', payload);
    socket.to(GAME_ROOM).emit('playerHitFlash', { targetId: tsid });
  });

  on('playerDied', (d) => {
    const victim = players[socket.id];
    if (!victim || !fxRate(victim, 'died', 0.3, 2)) return;   // 連続で「やられた」と送るのを防ぐ
    let killerId = (d && d.killerId) ? String(d.killerId) : null;
    const lh = victim.lastHitBy;
    if (killerId && (killerId === socket.id || !players[killerId] || !lh || lh.sid !== killerId || Date.now() - lh.at > 15000)) killerId = null;   // ★自分で自分を「倒した」ことにしてKPを増やす不正を防ぐ
    const killerName = killerId ? players[killerId].name : ((d && d.killerName) ? String(d.killerName).slice(0, 30) : null);
    victim.lastDeath = { at: Date.now(), killerId: killerId, weaponId: String(victim.weaponId || ''), used: false };
    victim.lastHitBy = null;
    io.emit('killFeed', { victimId: socket.id, victimName: victim.name, killerId: killerId, killerName: killerName });
  });

  on('weaponStolen', (d) => {   // 倒した人から「武器を受け取れた」の知らせ → 倒された人の手持ちから、その武器を消させる
    if (!d || !d.victimId) return;
    const victim = players[d.victimId], ld = victim && victim.lastDeath;
    if (!ld || ld.used || ld.killerId !== socket.id) return;        // その人を倒した本人だけ
    if (Date.now() - ld.at > FX_STEAL_WINDOW_MS) return;             // 倒してから時間がたちすぎ
    const wid = String(d.weaponId || '').slice(0, 30);
    if (!wid || wid !== ld.weaponId) return;                         // 倒された時に持っていた武器だけ
    ld.used = true;                                                  // 1回の死亡につき1回だけ
    const thief = players[socket.id];
    io.to(d.victimId).emit('weaponTaken', { weaponId: wid, thiefName: thief ? thief.name : '誰か' });
  });

  on('fxDropSpawn', (d) => {   // ★落とし物を出す（やられた時・ゴミ箱・箱をこわした時）
    const p = players[socket.id];
    if (!p || !d || !Array.isArray(d.list) || !fxRate(p, 'dropSpawn', 3, 8)) return;
    const src = (d.src === 'death' || d.src === 'crate') ? d.src : 'trash';
    const recs = [];
    for (let i = 0; i < d.list.length && i < FX_DROP_PER_EVENT; i++) { const r = fxDropClean(d.list[i], src, socket.id); if (r) recs.push(r); }
    if (!recs.length) return;
    fxDropMakeRoom(recs.length);
    const pub = recs.map((r) => { r.did = ++fxDropSeq; fxDrops.set(r.did, r); return fxDropPublic(r); });
    io.to(GAME_ROOM).emit('fxDropAdd', { list: pub });
  });
  on('fxDropPick', (d) => {   // ★拾う（先に届いた1人だけが拾える）
    const p = players[socket.id];
    const did = d && d.did;
    if (!p || !Number.isInteger(did) || !fxRate(p, 'dropPick', 10, 14)) return;
    const r = fxDrops.get(did);
    if (!r) return;
    if (Math.hypot(p.x - r.x, p.z - r.z) > FX_DROP_PICK_REACH || Math.abs(p.y - r.y) > FX_DROP_PICK_REACH + 4) return;   // 遠すぎる
    fxDrops.delete(did);
    io.to(GAME_ROOM).emit('fxDropGone', { ids: [did] });
    socket.emit('fxDropGot', { did: did, k: r.k, id: r.id, n: r.n, am: r.am, at: r.at });
    if (r.src === 'death' && r.k === 'w' && r.s !== socket.id && players[r.s]) {   // 倒された人が落とした武器を、ほかの人が拾った → 落とした人に知らせる
      io.to(r.s).emit('weaponTaken', { weaponId: r.id, thiefName: p.name, fx21: true });
    }
  });

  on('hitBot', (d) => {
    if (!d) return;
    const me = players[socket.id];
    if (!me || !(me.health > 0) || fxInSafeTower(me) || !fxBucket(me, 'hitB', 40, 30, 1)) return;
    const bot = bots.find(b => b.id === d.botId);
    if (!bot || bot.health <= 0) return;
    bot.health -= num(d.damage, 0, 250, 0);
    if (d.stunMs) bot.stunnedUntil = Date.now() + num(d.stunMs, 0, 6000, 0);
    const slowB = num(d.slowMs, 0, FX_SLOW_MAX_MS, 0);   // ★ゴッドライフルで撃たれたBotは、しばらく鈍足
    if (slowB > 0) bot.slowUntil = Math.max(bot.slowUntil || 0, Date.now() + slowB);
    socket.to(GAME_ROOM).emit('botHitFlash', { botId: bot.id }); // 本人は既にローカルで点滅済みなので、他の人にだけ知らせる
    if (bot.health <= 0) {
      const attacker = players[socket.id];
      io.emit('botKilled', { botId: bot.id, killerId: socket.id, killerName: attacker ? attacker.name : '???' });
      respawnBotLater(bot);
    } else if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      const f = num(d.kbForce, 0, BOT_KB_MAX, 2);
      bot.x += num(d.kbX, -1.5, 1.5, 0) * f;
      bot.z += num(d.kbZ, -1.5, 1.5, 0) * f;
      clampBotToWorld(bot);
      if (d.kbVertical) bot.vy = Math.max(bot.vy, Math.min(BOT_UP_MAX, BOT_UP_BASE + f * BOT_UP_RATIO));   // ★上にも吹き飛ぶ
    }
  });

  on('breakCrate', (d) => {
    const crate = d && onlineCrates.find(c => c.id === d.crateId);
    if (!crate || !crate.alive) return;
    crate.alive = false;
    io.emit('crateUpdate', onlineCrates);
    setTimeout(() => {
      const H = FIELD_HALF;
      let x, z;
      do { x = (Math.random() - 0.5) * H * 1.7; z = (Math.random() - 0.5) * H * 1.7; } while (Math.hypot(x - ONLINE_TOWER.x, z - ONLINE_TOWER.z) < 20);
      crate.x = x; crate.z = z; crate.alive = true;
      io.emit('crateUpdate', onlineCrates);
    }, 30000);
  });

  on('kickPlayer', (d) => {   // ★Owner だけ
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    (async () => {
      if (!(await fxOwnerRefresh(true))) return;
      const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
      if (!targetSid || targetSid === socket.id) return;
      io.to(targetSid).emit('youWereKicked', {});
      const s = io.sockets.sockets.get(targetSid);
      if (s) s.disconnect(true);
    })().catch((e) => console.error('[kick]', e && e.message));
  });

  // ---- ★飛行機の同期：位置・向きなどを、ほかの人にそのまま中継する（数字は範囲内に直す）。最後の状態は、あとから入った人のために覚えておく ----
  let plLastAt = 0;
  on('plState', (d) => {
    if (!d || typeof d !== 'object' || !players[socket.id]) return;
    const now = Date.now(); if (now - plLastAt < 50) return; plLastAt = now;
    fxPlaneSids.add(socket.id);
    const pay = { sid: socket.id, x: fxNum(d.x, 1000), y: fxNum(d.y, 1000), z: fxNum(d.z, 1000), yaw: fxNum(d.yaw, 7), pitch: fxNum(d.pitch, 7), roll: fxNum(d.roll, 7), thr: fxNum(d.thr, 1), eng: d.eng ? 1 : 0, lt: d.lt ? 1 : 0, bm: Math.max(0, Math.min(10, Math.floor(Number(d.bm) || 0))), rd: d.rd ? 1 : 0 };
    fxPlaneLast.set(socket.id, pay);   // ★覚えておく（止まっている飛行機を、あとから入った人にも見せるため）
    socket.to(GAME_ROOM).emit('plRemote', pay);
  });
  on('plGone', (d) => {
    fxPlaneLast.delete(socket.id);
    if (!fxPlaneSids.delete(socket.id)) return;
    socket.to(GAME_ROOM).emit('plGone', { sid: socket.id, boom: d && d.boom ? 1 : 0 });
  });

  on('fxDeviceIdAsk', (d) => {   // ★Owner だけ：ユーザー名から DeviceID を調べる。答えは、聞いた本人にだけ返す（ほかの人には送らない）
    const me = players[socket.id];
    const name = String((d && d.targetName) || '').trim().slice(0, 40);
    if (!me || !name) return;
    const reply = (o) => socket.emit('fxDeviceIdResult', o);
    if (!fxRate(me, 'devid', 0.5, 3)) { reply({ ok: false, msg: '少しゆっくり使ってください' }); return; }
    (async () => {
      if (!(await fxOwnerRefresh(true))) { reply({ ok: false, msg: 'Owner だけが使えます' }); return; }   // 毎回、GASでほんとうに確かめる
      const low = name.toLowerCase();
      const sids = Object.keys(players).filter((s) => String(players[s].name).toLowerCase() === low);
      if (sids.length === 1) { const t = players[sids[0]]; reply({ ok: true, name: t.name, deviceId: String(t.id), online: true }); return; }   // オンラインの人は、サーバーの記憶から（GASに聞かない）
      if (sids.length > 1) { reply({ ok: false, msg: '同じ名前の人が複数います' }); return; }
      const mine = players[socket.id];
      if (!mine) return;
      const j = await fxGasPost({ action: 'fpsOwnerWhoIs', id: mine.id, targetName: name });   // オフラインの人は GAS に聞く（GAS側でもOwnerを確認）
      if (j && j.status === 'success' && j.targetId) reply({ ok: true, name: String(j.name || name), deviceId: String(j.targetId), online: false });
      else reply({ ok: false, msg: (j && j.msg) || 'GAS につながりません' });
    })().catch((e) => { console.error('[deviceid]', e && e.message); reply({ ok: false, msg: 'エラーが出ました' }); });
  });

  // ---- ★BAN杖：Owner が相手をBAN（GAS に書きこんでから、演出を全員に配る） ----
  on('fxBanRequest', (d) => {
    if (!d || !players[socket.id]) return;
    const reply = (ok, msg) => socket.emit('fxBanResult', { ok: ok, msg: msg });
    const now = Date.now();
    if (fxBanBusyUntil > now) { reply(false, '別のBANの演出中です。少し待ってください'); return; }
    const me = players[socket.id];
    if (!me.owner) { reply(false, 'Owner だけが使えます'); return; }   // 入口は記憶で即答（ほんとうの確認は、裏でGASがする）
    let tsid = (d.targetId && players[String(d.targetId)]) ? String(d.targetId) : null;
    if (!tsid) { const q = String(d.targetName || '').trim().toLowerCase(); tsid = Object.keys(players).find(s => players[s].name.toLowerCase() === q) || null; }
    if (!tsid) { reply(false, 'その人は、もうオンラインにいません'); return; }
    if (tsid === socket.id) { reply(false, '自分はBANできません'); return; }
    const t = players[tsid];
    const reason = String(d.reason || '').replace(/[\[\]()'"\r\n]/g, '').trim().slice(0, 60);
    const minutes = Math.max(0, Math.min(2628000, Math.floor(Number(d.minutes) || 0)));
    const tName = t.name, tId = t.id, pos = { x: t.x, y: t.y, z: t.z };
    fxBanBusyUntil = now + FX_BAN_SHOW_MS + 14000;
    t.banLock = now + FX_BAN_SHOW_MS + 20000;

    // ★本人確認とBANの書きこみは、演出と同時に、裏で進める
    const task = (async () => {
      if (!(await fxOwnerRefresh(true))) return { ok: false, msg: 'Owner だけが使えます' };
      const j = await fxGasPost({ action: 'fpsOwnerBan', id: me.id, targetId: tId, reason: reason, minutes: minutes });
      if (!j || j.status !== 'success') return { ok: false, msg: (j && j.msg) || 'GAS につながりません（GAS_URL を確かめてください）' };
      return { ok: true };
    })().catch((e) => { console.error('[ban]', e && e.message); return { ok: false, msg: 'エラーが出ました' }; });

    io.to(GAME_ROOM).emit('fxBanStart', { ownerSid: socket.id, ownerName: me.name, targetSid: tsid, targetName: tName, x: pos.x, y: pos.y, z: pos.z, ms: FX_BAN_SHOW_MS, perm: minutes === 0 });
    reply(true, '執行します：' + tName);

    setTimeout(async () => {
      const r = await task;   // 演出が終わっても、GASの返事が遅ければ、ここで待つ
      if (!r.ok) {   // 失敗：演出を取り消して、相手を解放する
        const tt = players[tsid]; if (tt) tt.banLock = 0;
        fxBanBusyUntil = 0;
        io.to(GAME_ROOM).emit('fxBanAbort', {});
        reply(false, r.msg);
        return;
      }
      fxOwnerCache.delete(String(tId).trim());
      io.to(GAME_ROOM).emit('fxBanSlam', { ownerSid: socket.id, targetSid: tsid, x: pos.x, y: pos.y, z: pos.z });
      reply(true, 'BANしました：' + tName + (minutes ? '（' + minutes + '分）' : '（無期限）'));
      setTimeout(() => { io.to(tsid).emit('fxBanKill', {}); }, 600);
      setTimeout(() => { const s = io.sockets.sockets.get(tsid); if (s) s.disconnect(true); }, 3600);
    }, FX_BAN_SHOW_MS);
  });
  
  on('grantOrbital', (d) => {
    const me = players[socket.id];
    if (!me || !me.owner) return;   // ★Ownerだけ
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    const orbitalType = String((d && d.orbitalType) || '').trim();
    if (!isOrbitalType(orbitalType)) return;
    const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
    if (targetSid) io.to(targetSid).emit('orbitalGranted', { orbitalType: orbitalType, granterName: me.name });
  });

  on('meleeSwing', (d) => {
    const pa = players[socket.id]; if (pa) pa.lastAct = Date.now();
    socket.to(GAME_ROOM).emit('remoteMeleeSwing', { id: socket.id, weaponId: d && d.weaponId });
  });

  // ---- 防具の共有（"3,2,0,1" のような短い文字列。0＝なし、1〜3＝ランク、4＝ネザライト）----
  on('fxArmor', (d) => {
    const p = players[socket.id];
    const code = String((d && d.code) || '');
    if (!p || !/^[0-4],[0-4],[0-4],[0-4]$/.test(code)) return;
    p.armor = code;
  });

  // ---- コスチュームの共有（"wing_angel|aura_star|head_halo" のように「羽|キラキラ|頭」。からっぽは「なし」）----
  on('fxCostume', (d) => {
    const p = players[socket.id];
    const code = String((d && d.code) || '');
    if (!p || !fxRate(p, 'costume', 1, 4) || !/^[a-z0-9_]{0,24}\|[a-z0-9_]{0,24}\|[a-z0-9_]{0,24}$/.test(code)) return;
    p.costume = code;
  });

  // ---- ハワイの宝箱 ----
  on('fxChestSync', () => {
    socket.emit('fxChestState', { open: fxOpenChestIds() });
  });
  on('fxChestOpen', (d) => {
    const id = d && d.id;
    if (!players[socket.id] || !Number.isInteger(id) || id < 0 || id >= FX_CHEST_COUNT) return;
    const chest = fxChests[id];
    if (chest.open) { socket.emit('fxChestDenied', { id: id }); return; }   // 先に誰かが開けていた
    chest.open = true;
    chest.reopenAt = Date.now() + FX_CHEST_RESPAWN_MS;
    socket.emit('fxChestGranted', { id: id });                              // 開けた本人にだけ「中身をどうぞ」
    io.emit('fxChestState', { open: fxOpenChestIds() });                    // 全員に「開いた」と知らせる
  });

  // ---- ネザーの宝箱（ハワイの宝箱と同じしくみ。番号は 0〜FX_NCHEST_COUNT-1）----
  on('fxNChestSync', () => {
    socket.emit('fxNChestState', { open: fxNChestList() });
  });
  on('fxNChestOpen', (d) => {
    const id = d && d.id;
    const p = players[socket.id];
    if (!p || !Number.isInteger(id) || id < 0 || id >= FX_NCHEST_COUNT) return;
    const chest = fxNChests[id];
    if (p.y < NETHER_Y) { socket.emit('fxNChestDenied', { id: id, why: 'far' }); return; }   // ネザーにいない人は開けられない
    if (chest.open) { socket.emit('fxNChestDenied', { id: id, why: 'taken' }); return; }      // 先に誰かが開けていた
    chest.open = true;
    chest.reopenAt = Date.now() + (chest.rare ? FX_NCHEST_RARE_RESPAWN_MS : FX_NCHEST_RESPAWN_MS);
    socket.emit('fxNChestGranted', { id: id, rare: chest.rare });    // 開けた本人にだけ「中身をどうぞ」
    io.emit('fxNChestState', { open: fxNChestList() });              // 全員に「開いた」と知らせる
  });

  // ---- 設置物（銃台座・地雷）----
  on('fxPlacedSync', () => {
    socket.emit('fxPlacedList', { list: Object.values(fxPlaced).map(fxPlacedInfo) });
  });
  on('fxPlace', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
    const kind = d.kind === 'turret' ? 'turret' : (d.kind === 'mine' ? 'mine' : null);
    const x = Number(d.x), y = Number(d.y), z = Number(d.z);
    if (!kind || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.abs(x) > WORLD_HALF + 10 || Math.abs(z) > WORLD_HALF + 10 || y < -5 || y > PLACE_MAX_Y) {
      socket.emit('fxPlaceDenied', { kind: kind || 'mine', reason: '場所が正しくありません' }); return;
    }
    const lim = kind === 'turret' ? FX_MAX_TURRETS : FX_MAX_MINES;
    if (fxPlacedOwnedCount(socket.id, kind) >= lim) {
      socket.emit('fxPlaceDenied', { kind: kind, reason: (kind === 'turret' ? '銃台座は' : '地雷は') + lim + '個までです' }); return;
    }
    const o = { id: 'p' + (++fxPlacedSeq), kind: kind, ownerSid: socket.id, ownerName: String(p.name || 'プレイヤー').slice(0, 24), x: x, y: y, z: z, hp: kind === 'turret' ? FX_TURRET_HP : 1, gun: null };
    fxPlaced[o.id] = o;
    io.emit('fxPlacedAdd', { obj: fxPlacedInfo(o) });
  });
  on('fxMount', (d) => {   // 銃を付ける／外す（持ち主だけ）
    const o = d && fxPlaced[d.id];
    if (!o || o.ownerSid !== socket.id || o.kind !== 'turret') return;
    const gun = (d.gun === null || d.gun === undefined || d.gun === '') ? null : String(d.gun);
    if (gun !== null && !/^[a-z0-9_]{1,24}$/.test(gun)) return;
    o.gun = gun;
    io.emit('fxPlacedUpdate', { id: o.id, gun: o.gun });
  });
  on('fxRemove', (d) => {   // 撤去（持ち主だけ）
    const o = d && fxPlaced[d.id];
    if (!o || o.ownerSid !== socket.id) return;
    delete fxPlaced[o.id];
    io.emit('fxPlacedRemove', { id: o.id, reason: 'removed' });
  });
  on('fxHitPlaced', (d) => {   // 台座へのダメージ（持ち主以外）
    const o = d && fxPlaced[d.id];
    const me = players[socket.id];
    if (!o || !me || o.kind !== 'turret' || o.ownerSid === socket.id) return;
    const dmg = Math.min(FX_MAX_HIT_PER_SHOT, Math.max(0, Number(d.damage) || 0));
    if (dmg <= 0) return;
    o.hp -= dmg;
    if (o.hp <= 0) {
      delete fxPlaced[o.id];
      io.emit('fxPlacedRemove', { id: o.id, reason: 'destroyed', byId: socket.id, byName: me.name });
    } else {
      io.emit('fxPlacedHp', { id: o.id, hp: o.hp });
    }
  });
  on('fxMineTrigger', (d) => {   // 地雷が踏まれた（step）／持ち主のところにBotが来た（bot）／誘爆（chain）
    const o = d && fxPlaced[d.id];
    const me = players[socket.id];
    if (!o || o.kind !== 'mine' || !me) return;
    if (d.why === 'bot') { if (o.ownerSid !== socket.id) return; }
    else if (d.why === 'step') { if (o.ownerSid === socket.id || Math.hypot(me.x - o.x, me.z - o.z) > 7) return; }
    else if (d.why === 'chain') { if (Math.hypot(me.x - o.x, me.z - o.z) > 60) return; }
    else return;
    delete fxPlaced[o.id];
    const nowM = Date.now();   // 爆発に巻きこまれた人は「この地雷の持ち主に倒された」と覚えておく
    for (const s of Object.keys(players)) { const q = players[s]; if (Math.hypot(q.x - o.x, q.z - o.z) < 14) q.lastHitBy = { sid: o.ownerSid, at: nowM }; }
    io.emit('fxMineBoom', { id: o.id, x: o.x, y: o.y, z: o.z, ownerId: o.ownerSid, ownerName: o.ownerName, victimId: socket.id });
  });
  on('fxTAim', (d) => {   // 台座の頭の向き（他の人の画面で回して見せるため）
    const o = d && fxPlaced[d.id];
    if (!o || o.ownerSid !== socket.id || o.kind !== 'turret' || !Number.isFinite(d.yaw) || !Number.isFinite(d.pitch)) return;
    socket.to(GAME_ROOM).emit('fxTAimRelay', { id: o.id, yaw: d.yaw, pitch: d.pitch });
  });
  on('fxTBotHit', (d) => {   // タレット・地雷がBotに当たった（倒しても、誰にも報酬は出ません）
    if (!players[socket.id] || !d) return;
    const bot = bots.find(b => b.id === d.botId);
    if (!bot || bot.health <= 0) return;
    bot.health -= Math.min(80, Math.max(0, Number(d.damage) || 0));
    socket.to(GAME_ROOM).emit('botHitFlash', { botId: bot.id });
    if (bot.health <= 0) {
      io.emit('botKilled', { botId: bot.id, killerId: null, killerName: '🛠️ 設置物' });
      respawnBotLater(bot);
    }
  });

  // ---- ブロック（⑲）：置く・壊す・爆発で壊れる／マップの建物を壊す ----
  on('fxBlockSync', () => {   // いまの全部を教えて（参加した時・つなぎ直した時・食い違った時）
    socket.emit('fxBlockList', fxBlockSnapshot());
  });
  on('fxBlockPlace', (d) => {
    const p = players[socket.id], c = fxCell(d);
    if (!p || !c) return;
    const deny = (why) => socket.emit('fxBlockDenied', { act: 'place', x: c[0], y: c[1], z: c[2], reason: why });
    const kind = (d && typeof d.kind === 'string') ? d.kind : '';   // 文字だけ受け付ける（数字などは種類として認めない）
    if (!FX_BLOCK_KIND_RE.test(kind)) { deny('ブロックの種類が正しくありません'); return; }
    if (!fxRate(p, 'place', 10, 14)) { deny('速すぎます。少しゆっくり置いてください'); return; }
    const why = fxPlaceWhyNot(p, socket.id, c[0], c[1], c[2]);
    if (why) { deny(why); return; }
    const b = fxBlockAddNow(socket.id, p, c[0], c[1], c[2], kind);
    io.emit('fxBlockAdd', { x: b.x, y: b.y, z: b.z, kind: b.kind, by: b.ownerName });   // 置いた本人にも届く（本人の画面の「予想」を確かなものにする）
  });
  on('fxBlockBreak', (d) => {   // つるはしで壊した
    const p = players[socket.id], c = fxCell(d);
    if (!p || !c || !fxRate(p, 'break', 12, 16)) return;
    const key = fxKeyOf(c[0], c[1], c[2]), b = fxBlocks.get(key);
    if (!b) return;   // もう無い（誰かが先に壊した）
    if (p.y >= NETHER_Y || !fxNear(p, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5, FX_BLOCK_REACH)) {
      socket.emit('fxBlockDenied', { act: 'break', x: c[0], y: c[1], z: c[2], kind: b.kind, reason: '遠すぎます。近づいてください' });
      return;
    }
    fxBlockRemoveKey(key);
    io.emit('fxBlockRemove', { keys: [key], fx: true });
  });
  on('fxMapBreak', (d) => {   // つるはしで、マップの建物・岩・壁を壊した（名前はクライアントが決めた物）
    const p = players[socket.id];
    if (!p || !d || !Array.isArray(d.keys) || p.y >= NETHER_Y || !fxRate(p, 'mapbreak', 8, 12)) return;
    const keys = [];
    d.keys.slice(0, 6).forEach((k) => {
      const q = fxMapKeyInfo(k);
      if (!q || Math.hypot(p.x - q.x, p.z - q.z) > FX_BLOCK_REACH + q.size / 2 + 2) return;   // 遠すぎる物は壊せない
      keys.push(k);
    });
    const fresh = fxMapBreakKeys(keys);
    if (fresh.length) io.emit('fxMapBroken', { keys: fresh, remain: FX_MAP_RESTORE_MS });
  });
  on('fxBlockBlast', (d) => {   // 爆発（TNT・ニューク・手榴弾など）で壊れた分を、まとめて受け取る
    const p = players[socket.id];
    if (!p || !d || p.y >= NETHER_Y || !fxRate(p, 'blast', 20, 40)) return;
    const gone = [], maps = [];
    (Array.isArray(d.blocks) ? d.blocks : []).slice(0, 400).forEach((k) => {
      const c = fxParseKey(k);
      if (!c) return;
      const key = fxKeyOf(c[0], c[1], c[2]);
      if (fxBlockRemoveKey(key)) gone.push(key);
    });
    (Array.isArray(d.maps) ? d.maps : []).slice(0, 400).forEach((k) => { if (fxMapKeyInfo(k)) maps.push(k); });
    const fresh = fxMapBreakKeys(maps);
    if (gone.length) io.emit('fxBlockRemove', { keys: gone, fx: true });
    if (fresh.length) io.emit('fxMapBroken', { keys: fresh, remain: FX_MAP_RESTORE_MS });
  });

    // ---- ★線路とトロッコ ----
  on('fxrSync', () => { socket.emit('fxrList', fxrSnapshot()); });
  on('fxrPlace', (d) => {
    const p = players[socket.id], c = fxCell(d);
    if (!p || !c) return;
    const deny = (why) => socket.emit('fxrDenied', { act: 'rail', x: c[0], y: c[1], z: c[2], reason: why });
    if (!fxRate(p, 'rail', 8, 12)) { deny('速すぎます。少しゆっくり置いてください'); return; }
    if (p.y >= NETHER_Y) { deny('ネザーでは使えません'); return; }
    if (c[0] < -FX_BLOCK_HALF || c[0] + 1 > FX_BLOCK_HALF || c[2] < -FX_BLOCK_HALF || c[2] + 1 > FX_BLOCK_HALF || c[1] < 0 || c[1] > FX_BLOCK_MAX_Y) { deny('そこには置けません'); return; }
    if (!fxNear(p, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5, FX_BLOCK_REACH)) { deny('遠すぎます。近づいてください'); return; }
    const key = fxKeyOf(c[0], c[1], c[2]);
    if (fxRails.has(key) || fxBlocks.has(key)) { deny('そこにはもう物があります'); return; }
    const own = fxOwnerKey(p, socket.id);
    if (fxRails.size >= FXR_MAX_RAILS) { deny('線路は、みんなで合計 ' + FXR_MAX_RAILS + ' 本までです'); return; }
    if ((fxRailOwned[own] || 0) >= FXR_MAX_RAILS_PER) { deny('あなたが置いておける線路は ' + FXR_MAX_RAILS_PER + ' 本までです'); return; }
    const ax = d.ax === 'z' ? 'z' : 'x';
    fxRails.set(key, { x: c[0], y: c[1], z: c[2], ax: ax, owner: own });
    fxRailOwned[own] = (fxRailOwned[own] || 0) + 1;
    io.to(GAME_ROOM).emit('fxrAdd', { x: c[0], y: c[1], z: c[2], ax: ax });
  });
  on('fxrBreak', (d) => {
    const p = players[socket.id], c = fxCell(d);
    if (!p || !c || !fxRate(p, 'railb', 10, 14)) return;
    const key = fxKeyOf(c[0], c[1], c[2]), r = fxRails.get(key);
    if (!r || !fxNear(p, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5, FX_BLOCK_REACH)) return;
    fxRails.delete(key);
    const n = (fxRailOwned[r.owner] || 1) - 1;
    if (n > 0) fxRailOwned[r.owner] = n; else delete fxRailOwned[r.owner];
    io.to(GAME_ROOM).emit('fxrRemove', { key: key });
  });
  on('fxrCartSpawn', (d) => {
    const p = players[socket.id], c = fxCell(d);
    if (!p || !c || !fxRate(p, 'cart', 2, 4)) return;
    const deny = (why) => socket.emit('fxrDenied', { act: 'cart', reason: why });
    if (!fxRails.has(fxKeyOf(c[0], c[1], c[2]))) { deny('線路の上に置いてください'); return; }
    if (!fxNear(p, c[0] + 0.5, c[1] + 0.5, c[2] + 0.5, FX_BLOCK_REACH)) { deny('遠すぎます。近づいてください'); return; }
    const own = fxOwnerKey(p, socket.id);
    let mine = 0; fxCarts.forEach((k) => { if (k.owner === own) mine++; });
    if (mine >= FXR_MAX_CARTS_PER) { deny('あなたが置いておけるトロッコは ' + FXR_MAX_CARTS_PER + ' 台までです'); return; }
    if (fxCarts.size >= FXR_MAX_CARTS) { deny('トロッコは、みんなで合計 ' + FXR_MAX_CARTS + ' 台までです'); return; }
    let dx = Math.sign(Number(d.dx) || 0), dz = Math.sign(Number(d.dz) || 0);
    if (Math.abs(dx) + Math.abs(dz) !== 1) { dx = 1; dz = 0; }
    const cart = { id: 'k' + (++fxCartSeq), x: c[0] + 0.5, y: c[1], z: c[2] + 0.5, dx: dx, dz: dz, sp: 0, rider: null, owner: own };
    fxCarts.set(cart.id, cart);
    io.to(GAME_ROOM).emit('fxrCartAdd', fxCartInfo(cart));
  });
  on('fxrCartBoard', (d) => {
    const p = players[socket.id], cart = d && fxCarts.get(String(d.id));
    if (!p || !cart || !fxRate(p, 'cartb', 2, 4)) return;
    if (cart.rider && cart.rider !== socket.id && players[cart.rider]) { socket.emit('fxrDenied', { act: 'board', reason: '誰かが乗っています' }); return; }
    if (!fxNear(p, cart.x, cart.y + 0.5, cart.z, FX_BLOCK_REACH)) { socket.emit('fxrDenied', { act: 'board', reason: '遠すぎます。近づいてください' }); return; }
    fxrFreeRider(socket.id);
    cart.rider = socket.id;
    io.to(GAME_ROOM).emit('fxrCartRider', { id: cart.id, rider: socket.id });
    socket.emit('fxrBoarded', { id: cart.id });
  });
  on('fxrCartLeave', () => { fxrFreeRider(socket.id); });
  on('fxrCartState', (d) => {
    const p = players[socket.id], cart = d && fxCarts.get(String(d.id));
    if (!p || !cart || cart.rider !== socket.id || !fxRate(p, 'cartS', 25, 40)) return;
    cart.x = fxNum(d.x, 400); cart.y = fxNum(d.y, 400); cart.z = fxNum(d.z, 400); cart.sp = fxNum(d.sp, 60);
    cart.dx = Math.sign(Number(d.dx) || 0); cart.dz = Math.sign(Number(d.dz) || 0);
    if (Math.abs(cart.dx) + Math.abs(cart.dz) !== 1) { cart.dx = 1; cart.dz = 0; }
    socket.to(GAME_ROOM).emit('fxrCartState', { id: cart.id, x: cart.x, y: cart.y, z: cart.z, dx: cart.dx, dz: cart.dz, sp: cart.sp });
  });
  on('fxrCartRemove', (d) => {
    const p = players[socket.id], cart = d && fxCarts.get(String(d.id));
    if (!p || !cart || (cart.rider && players[cart.rider])) return;
    if (!fxNear(p, cart.x, cart.y + 0.5, cart.z, FX_BLOCK_REACH)) return;
    fxCarts.delete(cart.id);
    io.to(GAME_ROOM).emit('fxrCartGone', { id: cart.id });
  });

  // ---- チャット ----
  on('chatMessage', (d) => {
    const p = players[socket.id];
    const text = String((d && d.text) || '').slice(0, 200);
        if (!p || !fxRate(p, 'chat', 0.05, 15)) return;
    if (!text) return;
    socket.broadcast.emit('chatBroadcast', { name: p ? p.name : '???', text: text });
  });

  // ---- 懸賞金のおしらせ（お金のやりとりは GAS で行う。ここは「知らせを配る」だけ）----
  on('bountyEvent', (d) => {
    const p = players[socket.id];
    if (!p || !d || typeof d !== 'object' || !fxRate(p, 'bounty', 4, 8)) return;
    const type = d.type === 'claim' ? 'claim' : (d.type === 'place' ? 'place' : '');
    const target = String(d.target || '').slice(0, 30), amount = Math.floor(Number(d.amount)), total = Math.floor(Number(d.total) || 0);
    if (!type || !target || !(amount >= 0 && amount <= 100000)) return;
    socket.broadcast.emit('bountyEvent', { type: type, from: p.name, target: target, amount: amount, total: Math.max(0, Math.min(100000, total)) });
  });

  on('chatJoin', (d) => {
    const permId = String((d && d.id) || '').trim().toLowerCase();
    if (!permId) return;
    chatOnlineUsers[permId] = socket.id;
  });

  on('dmMessage', (d) => {
    if (!d || !d.targetId) return;
    const targetPermId = String(d.targetId).trim().toLowerCase();
    const targetSocketId = chatOnlineUsers[targetPermId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('dmMessage', { senderId: d.senderId, senderName: d.senderName, text: d.text });
    }
  });

  on('groupMessage', (d) => {
    if (!d || !d.groupId || !Array.isArray(d.memberIds)) return;
    const senderIdLower = String(d.senderId).trim().toLowerCase();
    d.memberIds.forEach(function (memberPermId) {
      const memberIdLower = String(memberPermId).trim().toLowerCase();
      if (memberIdLower === senderIdLower) return;
      const targetSocketId = chatOnlineUsers[memberIdLower];
      if (targetSocketId) {
        io.to(targetSocketId).emit('groupMessage', { groupId: d.groupId, groupName: d.groupName, senderId: d.senderId, senderName: d.senderName, text: d.text });
      }
    });
  });

  on('disconnect', () => {
    console.log('退出:', players[socket.id] ? players[socket.id].name : socket.id);
    fxPlaneLast.delete(socket.id);   // ★飛行機の記憶も消す
        fxrFreeRider(socket.id);   // ★乗っていたトロッコを空きにする
    if (fxPlaneSids.delete(socket.id)) io.to(GAME_ROOM).emit('plGone', { sid: socket.id, boom: 0 });
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
    if (Object.keys(players).length === 0) { fxBlocksResetAll(); fxDrops.clear(); fxPlaneLast.clear(); fxPlaneSids.clear(); fxrResetAll();}   // ★誰もいなくなったら、ブロックも壊れた建物も、飛行機の記憶も、はじめに戻す
    for (const id of Object.keys(fxPlaced)) {
      if (fxPlaced[id].ownerSid === socket.id) { delete fxPlaced[id]; io.emit('fxPlacedRemove', { id: id, reason: 'left' }); }
    }
    for (const permId in chatOnlineUsers) {
      if (chatOnlineUsers[permId] === socket.id) { delete chatOnlineUsers[permId]; break; }
    }
  });
});

// ==========================================
// ⏱️ 定期的な処理
// ==========================================
let lastPlayersJson = '', lastPlayersAt = 0, lastBotsJson = '', lastBotsAt = 0;
setInterval(() => {   // ゲームに入っている人にだけ、全員の位置・Botの位置を配る（0.1秒ごと）。前回と同じ内容なら、3秒に1回だけ
  const room = io.sockets.adapter.rooms.get(GAME_ROOM);
  if (!room || room.size === 0) return;   // 誰もゲームに入っていなければ、何も送らない
  const now = Date.now();
  const pl = publicPlayers(), ps = JSON.stringify(pl);
  if (ps !== lastPlayersJson || now - lastPlayersAt >= BCAST_KEEPALIVE_MS) { lastPlayersJson = ps; lastPlayersAt = now; io.to(GAME_ROOM).emit('playersUpdate', pl); }
  const bl = publicBots(), bs = JSON.stringify(bl);
  if (bs !== lastBotsJson || now - lastBotsAt >= BCAST_KEEPALIVE_MS) { lastBotsJson = bs; lastBotsAt = now; io.to(GAME_ROOM).emit('botsUpdate', bl); }
}, 100);

setInterval(() => {   // ★落とし物の時間切れ（一定時間たったら消える）
  if (fxDrops.size === 0) return;
  const now = Date.now(), gone = [];
  for (const [did, r] of fxDrops) { if (now - r.born >= FX_DROP_LIFETIME_MS) { fxDrops.delete(did); gone.push(did); } }
  if (gone.length) io.to(GAME_ROOM).emit('fxDropGone', { ids: gone });
}, 5000);

setInterval(() => {   // Botの上下の動き（吹き飛ばされたら、重力で落ちてくる）
  const dt = 0.05;
  for (const bot of bots) {
    if (bot.health <= 0) continue;
    if (bot.vy === 0 && bot.y <= BOT_REST_Y) continue;
    bot.vy -= BOT_GRAV * dt;
    bot.y += bot.vy * dt;
    if (bot.y <= BOT_REST_Y) { bot.y = BOT_REST_Y; bot.vy = 0; }
  }
}, 50);

function botFireVolley(bot, gun, targetSid) {   // 1回ぶんの射撃（連射する武器は、間をあけて何発か）
  for (let k = 0; k < gun.n; k++) {
    const fire = () => {
      if (bot.health <= 0) return;                 // 撃っている途中でやられたら、そこでやめる
      const p = players[targetSid];
      if (!p || p.health <= 0 || p.y >= TOWER_SAFE_Y) return;
      botFireBullet(bot, gun, p, targetSid);
    };
    if (k === 0) fire(); else setTimeout(fire, k * gun.burstGap);
  }
}
function botFireBullet(bot, gun, p, targetSid) {   // 1発（ショットガンは、見た目の粒を何個か）
  const bulletSpeed = Math.round(gun.speed * BOT_BULLET_MUL);
  const dx0 = p.x - bot.x, dy0 = p.y - bot.y, dz0 = p.z - bot.z;
  const dist = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);
  const travelTime = dist / bulletSpeed;
  const leadX = p.x + (p.velX || 0) * travelTime * 0.9;
  const leadZ = p.z + (p.velZ || 0) * travelTime * 0.9;
  const originX = bot.x, originY = bot.y + 1.3, originZ = bot.z;
  const tdx = leadX - originX, tdy = (p.y + 0.9) - originY, tdz = leadZ - originZ;
  const tlen = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz) || 1;
  const aim = (spread) => {
    let ax = tdx / tlen + (Math.random() - 0.5) * spread, ay = tdy / tlen + (Math.random() - 0.5) * spread, az = tdz / tlen + (Math.random() - 0.5) * spread;
    const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    return { x: ax / al, y: ay / al, z: az / al };
  };
  const main = aim(gun.spread);
  io.to(GAME_ROOM).emit('remoteShotFired', { originX, originY, originZ, dirX: main.x, dirY: main.y, dirZ: main.z, weaponId: bot.weaponId });
  const pellets = gun.pellets || 1;
  for (let k = 1; k < pellets; k++) {   // ショットガンの、見た目だけの粒
    const a2 = aim(gun.spread + 0.1);
    io.to(GAME_ROOM).emit('remoteShotFired', { originX, originY, originZ, dirX: a2.x, dirY: a2.y, dirZ: a2.z, weaponId: bot.weaponId });
  }
  const bulletTravelMs = Math.min(1800, Math.max(60, travelTime * 1000));
  setTimeout(() => {
    const p2 = players[targetSid];
    if (!p2 || p2.health <= 0) return;
    const travelSec = bulletTravelMs / 1000;
    const bulletX = originX + main.x * bulletSpeed * travelSec;
    const bulletY = originY + main.y * bulletSpeed * travelSec;
    const bulletZ = originZ + main.z * bulletSpeed * travelSec;
    const ddx = p2.x - bulletX, ddy = (p2.y - 0.8) - bulletY, ddz = p2.z - bulletZ;
    const hitDist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (hitDist < 2.2 && !fxLineBlocked(originX, originY, originZ, p2.x, p2.y - 0.8, p2.z)) {   // ★弾が飛んでいる間にブロックが置かれたら、当たらない
      let damage = gun.dmg;
      if (pellets > 1) damage = gun.dmg * Math.round(pellets * Math.max(0, 1 - dist / gun.range));   // ショットガン：近いほど、粒がたくさん当たる
      damage = Math.round(damage);
      if (damage > 0) io.to(targetSid).emit('youWereHit', { damage: damage, attackerName: '🤖 Bot', attackerId: null });
    }
  }, bulletTravelMs);
}

setInterval(() => {   // BotのAI（0.2秒ごと）
  const now = Date.now();
  for (const bot of bots) {
    if (bot.health <= 0) continue;
    if (bot.stunnedUntil && now < bot.stunnedUntil) continue;
    const slowK = (bot.slowUntil && now < bot.slowUntil) ? BOT_SLOW_MUL : 1;   // ★鈍足中は、動きが 0.4 倍

    let nearest = null, nearestDist = Infinity, nearestSid = null;
    for (const sid of Object.keys(players)) {
      const p = players[sid];
      const dx = p.x - bot.x, dy = p.y - bot.y, dz = p.z - bot.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < nearestDist) { nearestDist = d; nearest = p; nearestSid = sid; }
    }

    if (nearest && nearestDist < 40 && nearest.y < TOWER_SAFE_Y) {
      const dx = nearest.x - bot.x, dz = nearest.z - bot.z;
      const horizLen = Math.hypot(dx, dz) || 1;
      if (horizLen > 8) {
        const moved = resolveBotMove(bot.x, bot.z, bot.x + (dx / horizLen) * 0.5 * slowK, bot.z + (dz / horizLen) * 0.5 * slowK, bot.y);
        bot.x = moved.x; bot.z = moved.z;
      }

      const gun = BOT_GUNS[bot.weaponId] || BOT_GUNS.pistol;   // ★持っている武器ごとに、撃つ間隔・連射・ダメージ・届く距離が違う
      if (now - bot.lastShot > gun.gap && nearestDist <= gun.range && !fxLineBlocked(bot.x, bot.y + 1.3, bot.z, nearest.x, nearest.y + 0.9, nearest.z)) {   // ★ブロックの壁の向こうからは撃ってこない
        bot.lastShot = now;
        botFireVolley(bot, gun, nearestSid);
      }
    } else {
      if (Math.hypot(bot.targetX - bot.x, bot.targetZ - bot.z) < 1) {
        const p = randomSpot(); bot.targetX = p.x; bot.targetZ = p.z;
      }
      const dx = bot.targetX - bot.x, dz = bot.targetZ - bot.z;
      const len = Math.hypot(dx, dz) || 1;
      const moved = resolveBotMove(bot.x, bot.z, bot.x + (dx / len) * 0.2 * slowK, bot.z + (dz / len) * 0.2 * slowK, bot.y);
      bot.x = moved.x; bot.z = moved.z;
    }
  }
}, 200);

// どこかで想定外のエラーが起きても、サーバー全体は止めない（Render のログに出るだけ）
process.on('uncaughtException', (e) => { console.error('[想定外のエラー]', e && e.message); });
process.on('unhandledRejection', (e) => { console.error('[想定外のエラー]', e && e.message ? e.message : e); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('KP銃ゲー オンラインサーバー（ver.18・飛行機同期つき）起動しました。ポート: ' + PORT));
