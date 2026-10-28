// ==========================================
// KP銃ゲー オンライン対戦サーバー（完成版 ver.10）
// ==========================================

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
const FX_SLOW_MAX_MS = 50000;    // 鈍足の長さの上限（ズル対策）
const FX_GOD_MAX_DAMAGE = 150;   // ゴッドライフル1発のダメージの上限（ふつうは34、頭で51、攻撃力アップの薬でも約100）
const FX_GOD_MIN_GAP_MS = 150;   // ゴッドライフルの「特別な効果（防具無視・鈍足）」が付く最短の間隔（連射のズル対策。ふつうは260ms以上あきます）
const FIELD_HALF = 125;          // Botや箱が出てくる範囲（元のフィールドの半幅）
const WORLD_HALF = 150;          // 歩ける全体の半幅（⑫-A で外側に広げた分も入れた数字。FX13_EXTRA を変えたら「105＋その数字」にする）
const TOWER_SAFE_Y = 20;
const ONLINE_TOWER = { x: 0, z: 0 };
const SPAWN_Y = 96;              // 参加した直後の高さ（塔のてっぺん）
const NETHER_Y = 900;            // これより上にいる人は「ネザーにいる」
const PLACE_MAX_Y = 130;         // 銃台座・地雷を置ける高さの上限（塔のてっぺんは約92m）

// ---------- ブロック（クライアントの⑲）の決まり ----------
const FX_BLOCK_MAX_TOTAL = 500;           // ★クライアントの FX19_MAX_PLACED と同じ数字にしてください（ブロックの合計の上限・みんなの分）
const FX_BLOCK_MAX_PER_PLAYER = 230;      // 1人が同時に置いておける数
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
const BOT_UP_BASE = 2.5;         // 吹き飛ばされた時の上向きの速さ ＝ この数字 ＋ 「横に飛ばした距離(m)」 × BOT_UP_RATIO
const BOT_UP_RATIO = 2.5;        //   （オフラインのBotと同じ数字。TNTで3.5m飛ばされたBotは、約1.7mの高さまで跳ね上がります 2.7） 
const BOT_UP_MAX = 90;
const BOT_KB_MAX = 120;           // 1回の横の吹き飛ばしの上限（ズル対策）
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
const FX_NCHEST_RESPAWN_MS = 200000;       // ふつうの箱：開けてから、また閉まるまで
const FX_NCHEST_RARE_RESPAWN_MS = 350000;  // レアチェスト
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
const FX_MAX_MINES = 8;            // ★クライアントの数字（FX_MAX_MINES）と同じにしてください
const FX_MAX_TURRETS = 5;          // ★クライアントの数字（FX_MAX_TURRETS）と同じにしてください
const FX_TURRET_HP = 300;          // ★クライアントの数字（FX_TURRET_HP）と同じにしてください
const FX_MAX_HIT_PER_SHOT = 300;   // 1回のダメージの上限（ズル対策）
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

io.on('connection', (socket) => {
  const on = function (ev, fn) { socket.on(ev, guard(ev, fn)); };

  // 「新しいサーバーです」と知らせる（クライアントは、これが届いた時だけ、新しい機能を使います）
  socket.emit('fxServerInfo', { v: SERVER_VERSION, nChests: FX_NCHEST_COUNT, blocks: true, blockMax: FX_BLOCK_MAX_TOTAL, restoreMs: FX_MAP_RESTORE_MS });   // blocks＝ブロック対応

  on('join', (d) => {
    players[socket.id] = {
      id: (d && d.deviceId) || socket.id,
      name: String((d && d.name) || 'プレイヤー').slice(0, 24),
      x: ONLINE_TOWER.x, y: SPAWN_Y, z: ONLINE_TOWER.z, yaw: 0, pitch: 0,
      weaponId: 'pistol', health: 100, armor: '0,0,0,0', crouching: false,
      velX: 0, velZ: 0, lastUpdateT: 0, lastGodHitAt: 0
    };
    console.log('参加:', players[socket.id].name);
    socket.emit('crateUpdate', onlineCrates);
  });

  on('updateState', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
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

  on('shotFired', (d) => {
    if (!d || typeof d !== 'object') return;
    socket.broadcast.emit('remoteShotFired', d);
  });

  on('hitPlayer', (d) => {
    if (!d || !d.targetId) return;
    const attacker = players[socket.id];
    const payload = { damage: num(d.damage, 0, 250, 0), attackerName: attacker ? (attacker.name + (d.viaTurret ? 'のタレット' : '')) : '???', attackerId: socket.id };
    if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      payload.kbX = num(d.kbX, -1.5, 1.5, 0); payload.kbZ = num(d.kbZ, -1.5, 1.5, 0);
      payload.kbForce = num(d.kbForce, 0, 30, 6); payload.kbVertical = !!d.kbVertical;
    }
    if (d.stunMs) payload.stunMs = num(d.stunMs, 0, 6000, 0);
    if (d.weaponId === 'godrifle' && attacker) {   // ★ゴッドライフル：防具無視（pierce）と鈍足（slowMs）を、撃たれた相手に伝える（ほかの武器が送ってきても無視）
      payload.damage = Math.min(payload.damage, FX_GOD_MAX_DAMAGE);
      const nowG = Date.now();
      if (nowG - (attacker.lastGodHitAt || 0) >= FX_GOD_MIN_GAP_MS) {   // 連射が速すぎる時は、特別な効果なし（ダメージだけ）
        attacker.lastGodHitAt = nowG;
        if (d.pierce === true) payload.pierce = true;
        const slow = num(d.slowMs, 0, FX_SLOW_MAX_MS, 0);
        if (slow > 0) payload.slowMs = slow;
      }
    }
    io.to(d.targetId).emit('youWereHit', payload);
    socket.broadcast.emit('playerHitFlash', { targetId: d.targetId }); // 本人は既にローカルで点滅済みなので、他の人にだけ知らせる
  });

  on('playerDied', (d) => {
    const victim = players[socket.id];
    io.emit('killFeed', {
      victimId: socket.id,
      victimName: victim ? victim.name : '???',
      killerId: (d && d.killerId) || null,
      killerName: (d && d.killerName) || null
    });
  });

  on('hitBot', (d) => {
    if (!d) return;
    const bot = bots.find(b => b.id === d.botId);
    if (!bot || bot.health <= 0) return;
    bot.health -= num(d.damage, 0, 250, 0);
    if (d.stunMs) bot.stunnedUntil = Date.now() + num(d.stunMs, 0, 6000, 0);
    const slowB = num(d.slowMs, 0, FX_SLOW_MAX_MS, 0);   // ★ゴッドライフルで撃たれたBotは、しばらく鈍足
    if (slowB > 0) bot.slowUntil = Math.max(bot.slowUntil || 0, Date.now() + slowB);
    socket.broadcast.emit('botHitFlash', { botId: bot.id }); // 本人は既にローカルで点滅済みなので、他の人にだけ知らせる
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

  on('kickPlayer', (d) => {
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
    if (targetSid) {
      io.to(targetSid).emit('youWereKicked', {});
      const s = io.sockets.sockets.get(targetSid);
      if (s) s.disconnect(true);
    }
  });

  on('grantOrbital', (d) => {
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    const orbitalType = String((d && d.orbitalType) || '').trim();
    if (!isOrbitalType(orbitalType)) return;   // ★nuke＋数字・railgun も渡せる
    const granter = players[socket.id];
    const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
    if (targetSid) {
      io.to(targetSid).emit('orbitalGranted', { orbitalType: orbitalType, granterName: granter ? granter.name : '誰か' });
    }
  });

  on('meleeSwing', (d) => {
    socket.broadcast.emit('remoteMeleeSwing', { id: socket.id, weaponId: d && d.weaponId });
  });

  // ---- 防具の共有（"3,2,0,1" のような短い文字列。0＝なし、1〜3＝ランク、4＝ネザライト）----
  on('fxArmor', (d) => {
    const p = players[socket.id];
    const code = String((d && d.code) || '');
    if (!p || !/^[0-4],[0-4],[0-4],[0-4]$/.test(code)) return;
    p.armor = code;
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
    io.emit('fxMineBoom', { id: o.id, x: o.x, y: o.y, z: o.z, ownerId: o.ownerSid, ownerName: o.ownerName, victimId: socket.id });
  });
  on('fxTAim', (d) => {   // 台座の頭の向き（他の人の画面で回して見せるため）
    const o = d && fxPlaced[d.id];
    if (!o || o.ownerSid !== socket.id || o.kind !== 'turret' || !Number.isFinite(d.yaw) || !Number.isFinite(d.pitch)) return;
    socket.broadcast.emit('fxTAimRelay', { id: o.id, yaw: d.yaw, pitch: d.pitch });
  });
  on('fxTBotHit', (d) => {   // タレット・地雷がBotに当たった（倒しても、誰にも報酬は出ません）
    if (!players[socket.id] || !d) return;
    const bot = bots.find(b => b.id === d.botId);
    if (!bot || bot.health <= 0) return;
    bot.health -= Math.min(80, Math.max(0, Number(d.damage) || 0));
    socket.broadcast.emit('botHitFlash', { botId: bot.id });
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

  // ---- チャット ----
  on('chatMessage', (d) => {
    const p = players[socket.id];
    const text = String((d && d.text) || '').slice(0, 200);
    if (!text) return;
    socket.broadcast.emit('chatBroadcast', { name: p ? p.name : '???', text: text });
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
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
    if (Object.keys(players).length === 0) fxBlocksResetAll();   // ★誰もいなくなったら、ブロックも壊れた建物も、はじめに戻す
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
setInterval(() => {   // 全員の位置・Botの位置を配る（0.1秒ごと）
  io.emit('playersUpdate', players);
  io.emit('botsUpdate', bots.filter(b => b.health > 0).map(b => ({ id: b.id, x: b.x, y: b.y, z: b.z, weaponId: b.weaponId })));
}, 100);

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

      if (now - bot.lastShot > 1500 && !fxLineBlocked(bot.x, bot.y + 1.3, bot.z, nearest.x, nearest.y + 0.9, nearest.z)) {   // ★ブロックの壁の向こうからは撃ってこない
        bot.lastShot = now;
        const bulletSpeed = BOT_WEAPON_SPEED[bot.weaponId] || BOT_SPEED_DEFAULT;
        const travelTime = nearestDist / bulletSpeed;
        const leadX = nearest.x + (nearest.velX || 0) * travelTime * 0.9;
        const leadZ = nearest.z + (nearest.velZ || 0) * travelTime * 0.9;

        const originX = bot.x, originY = bot.y + 1.3, originZ = bot.z;
        const tdx = leadX - originX, tdy = (nearest.y + 0.9) - originY, tdz = leadZ - originZ;
        const tlen = Math.sqrt(tdx*tdx + tdy*tdy + tdz*tdz) || 1;
        const spread = 0.05;
        let aimX = tdx / tlen + (Math.random() - 0.5) * spread;
        let aimY = tdy / tlen + (Math.random() - 0.5) * spread;
        let aimZ = tdz / tlen + (Math.random() - 0.5) * spread;
        const alen = Math.sqrt(aimX*aimX + aimY*aimY + aimZ*aimZ) || 1;
        aimX /= alen; aimY /= alen; aimZ /= alen;

        io.emit('remoteShotFired', { originX, originY, originZ, dirX: aimX, dirY: aimY, dirZ: aimZ, weaponId: bot.weaponId });

        const targetSid = nearestSid;
        const bulletTravelMs = Math.min(1800, Math.max(60, travelTime * 1000));
        setTimeout(() => {
          const p2 = players[targetSid];
          if (!p2 || p2.health <= 0) return;
          const travelSec = bulletTravelMs / 1000;
          const bulletX = originX + aimX * bulletSpeed * travelSec;
          const bulletY = originY + aimY * bulletSpeed * travelSec;
          const bulletZ = originZ + aimZ * bulletSpeed * travelSec;
          const ddx = p2.x - bulletX, ddy = (p2.y - 0.8) - bulletY, ddz = p2.z - bulletZ;
          const hitDist = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
          if (hitDist < 2.2 && !fxLineBlocked(originX, originY, originZ, p2.x, p2.y - 0.8, p2.z)) {   // ★弾が飛んでいる間にブロックが置かれたら、当たらない
            io.to(targetSid).emit('youWereHit', { damage: 6, attackerName: '🤖 Bot', attackerId: null });
          }
        }, bulletTravelMs);
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
server.listen(PORT, () => console.log('KP銃ゲー オンラインサーバー（ver.10）起動しました。ポート: ' + PORT));
