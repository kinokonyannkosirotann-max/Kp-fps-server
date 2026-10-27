// ==========================================
// KP銃ゲー オンライン対戦サーバー（完成版 ver.10）
// ==========================================
// ★このファイルの中身を、Render のサーバーの「ファイル全部」と入れ替えてください（一部だけ直す方式ではありません）
// 前の版（server9）から増えたもの：
//  ・ブロック（クライアントの⑲）：置く・壊す・爆発で壊れる、を全員で共有（fxBlockPlace／fxBlockBreak／fxBlockBlast）
//     … 置ける数・距離・高さ・場所などは、サーバーが確かめます（ズル・バグ対策）。ブロックの種類は、クライアントが増やしても、そのまま使えます
//  ・壊れたマップの建物・岩・壁を全員で共有し、30分（FX_MAP_RESTORE_MS）たつと全員の画面で元に戻す（fxMapBreak／fxMapBroken／fxMapRestored）
//  ・Botは、置かれたブロックを通り抜けられず、ブロックの向こうからは撃ってこない（ブロックで身を守れます）
//  ・誰もいなくなったら、ブロックも壊れた建物も、はじめの状態に戻る
//  ・クライアントに「ブロック対応です」と知らせる（fxServerInfo の blocks）… 古いクライアントのままでも、今まで通り動きます
//
// それ以前（server9 までに入っていたもの）：
//  ・ゴッドライフル：当たった相手を「鈍足」にする／防具を無視するダメージを、撃たれた相手の画面へ伝える（hitPlayer の slowMs・pierce）
//  ・オンラインのBotも、ゴッドライフルで鈍足になる（hitBot の slowMs → 動きが 0.4 倍）
//  ・Botの弾の速さを、クライアントの「弾の速さ調整表（⑱-A）」と同じ倍率に（見た目と当たる速さをそろえる）
//  ・ニュークは「nuke」＋数字（nuke1〜nuke999）なら何でも他のプレイヤーに渡せる（grantOrbital）… 自分で作ったレベル10なども OK
//  ・ネザーの宝箱を、全員で同じ箱を取り合う形に（fxNChest…）
//  ・他のプレイヤーの「上下の向き（pitch）」と「しゃがみ」を中継（頭・武器が上を向く／しゃがみが見える）
//  ・オンラインのBotも、上に吹き飛ぶ（hitBot の kbVertical → 重力で落ちる）
//  ・ネザライト防具（Lv4）の共有
//  ・塔の上（高さ130mまで）と、広げたフィールドの外側にも、銃台座・地雷を置ける
//  ・おかしな数字（NaN・巨大なダメージ）を無視して、サーバーが落ちにくく
//  ・クライアントに「新しいサーバーです」と知らせる（fxServerInfo）… 古いサーバーのままでも、ゲームは今まで通り動きます
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => res.send('KP銃ゲー オンラインサーバー 稼働中です（ver.10）'));

const SERVER_VERSION = 10;
const players = {};
const BOT_COUNT = 2;
const BOT_WEAPONS = ['pistol', 'rifle'];
const BOT_BULLET_MUL = 1.7;      // ★クライアントの FX18_SPEED_ALL（全体の弾の速さの倍率）と同じ数字にしてください（見た目と当たる速さがそろいます）
const BOT_WEAPON_SPEED = { pistol: Math.round(55 * BOT_BULLET_MUL), rifle: Math.round(65 * BOT_BULLET_MUL) };
const BOT_SPEED_DEFAULT = Math.round(55 * BOT_BULLET_MUL);
const BOT_SLOW_MUL = 0.4;        // ★鈍足中のBotの動きの速さ（クライアントの FX18_SLOW_MUL と同じ）
const FX_SLOW_MAX_MS = 10000;    // 鈍足の長さの上限（ズル対策）
const FX_GOD_MAX_DAMAGE = 150;   // ゴッドライフル1発のダメージの上限（ふつうは34、頭で51、攻撃力アップの薬でも約100）
const FX_GOD_MIN_GAP_MS = 150;   // ゴッドライフルの「特別な効果（防具無視・鈍足）」が付く最短の間隔（連射のズル対策。ふつうは260ms以上あきます）
const FIELD_HALF = 105;          // Botや箱が出てくる範囲（元のフィールドの半幅）
const WORLD_HALF = 150;          // 歩ける全体の半幅（⑫-A で外側に広げた分も入れた数字。FX13_EXTRA を変えたら「105＋その数字」にする）
const TOWER_SAFE_Y = 20;
const ONLINE_TOWER = { x: 0, z: 0 };
const SPAWN_Y = 92;              // 参加した直後の高さ（塔のてっぺん）
const NETHER_Y = 900;            // これより上にいる人は「ネザーにいる」
const PLACE_MAX_Y = 130;         // 銃台座・地雷を置ける高さの上限（塔のてっぺんは約92m）

// ---------- ブロック（クライアントの⑲）の決まり ----------
const FX_BLOCK_MAX_TOTAL = 400;           // ★クライアントの FX19_MAX_PLACED と同じ数字にしてください（ブロックの合計の上限・みんなの分）
const FX_BLOCK_MAX_PER_PLAYER = 120;      // 1人が同時に置いておける数
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
    bots.push({ id: 'bot_' + i, x: p.x, y: BOT_REST_Y, vy: 0, z: p.z, targetX: p.x, targetZ: p.z, health: 100, weaponId: BOT_WEAPONS[i % BOT_WEAPONS.length], lastShot: 0, stunnedUntil: 0, slowUntil: 0 });
  }
}
initBots();
function respawnBotLater(bot) {
  setTimeout(() => {
    const p = randomSpot();
    bot.health = 100; bot.x = p.x; bot.z = p.z; bot.y = BOT_REST_Y; bot.vy = 0; bot.stunnedUntil = 0; bot.slowUntil = 0;
    bot.weaponId = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)];
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
