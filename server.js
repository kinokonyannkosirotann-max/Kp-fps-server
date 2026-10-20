// ==========================================
// KP銃ゲー オンライン対戦サーバー（完成版 ver.8）
// ==========================================
// 前の版（server7）から増えたもの：
//  ・ネザーの宝箱を、全員で同じ箱を取り合う形に（fxNChest…）
//  ・他のプレイヤーの「上下の向き（pitch）」と「しゃがみ」を中継（頭・武器が上を向く／しゃがみが見える）
//  ・オンラインのBotも、上に吹き飛ぶ（hitBot の kbVertical → 重力で落ちる）
//  ・ニューク1/2/3/5・railgun を、他のプレイヤーに渡せる（grantOrbital）
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

app.get('/', (req, res) => res.send('KP銃ゲー オンラインサーバー 稼働中です（ver.8）'));

const SERVER_VERSION = 8;
const players = {};
const BOT_COUNT = 2;
const BOT_WEAPONS = ['pistol', 'rifle'];
const BOT_WEAPON_SPEED = { pistol: 55, rifle: 65 };
const FIELD_HALF = 105;          // Botや箱が出てくる範囲（元のフィールドの半幅）
const WORLD_HALF = 150;          // 歩ける全体の半幅（⑫-A で外側に広げた分も入れた数字。FX13_EXTRA を変えたら「105＋その数字」にする）
const TOWER_SAFE_Y = 20;
const ONLINE_TOWER = { x: 0, z: 0 };
const SPAWN_Y = 93;              // 参加した直後の高さ（塔のてっぺん）
const NETHER_Y = 900;            // これより上にいる人は「ネザーにいる」
const PLACE_MAX_Y = 130;         // 銃台座・地雷を置ける高さの上限（塔のてっぺんは約92m）

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
function resolveBotMove(curX, curZ, desiredX, desiredZ) {
  let testX = desiredX;
  for (const ob of STATIC_OBSTACLES) {
    if (testX > ob.x - ob.hx && testX < ob.x + ob.hx && curZ > ob.z - ob.hz && curZ < ob.z + ob.hz) { testX = curX; break; }
  }
  let testZ = desiredZ;
  for (const ob of STATIC_OBSTACLES) {
    if (testX > ob.x - ob.hx && testX < ob.x + ob.hx && testZ > ob.z - ob.hz && testZ < ob.z + ob.hz) { testZ = curZ; break; }
  }
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
const BOT_UP_BASE = 3.8;         // 吹き飛ばされた時の上向きの速さ ＝ この数字 ＋ 「横に飛ばした距離(m)」 × BOT_UP_RATIO
const BOT_UP_RATIO = 1.5;        //   （オフラインのBotと同じ数字。TNTで3.5m飛ばされたBotは、約1.7mの高さまで跳ね上がります）
const BOT_UP_MAX = 12;
const BOT_KB_MAX = 15;           // 1回の横の吹き飛ばしの上限（ズル対策）
const bots = [];
function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const p = randomSpot();
    bots.push({ id: 'bot_' + i, x: p.x, y: BOT_REST_Y, vy: 0, z: p.z, targetX: p.x, targetZ: p.z, health: 100, weaponId: BOT_WEAPONS[i % BOT_WEAPONS.length], lastShot: 0, stunnedUntil: 0 });
  }
}
initBots();
function respawnBotLater(bot) {
  setTimeout(() => {
    const p = randomSpot();
    bot.health = 100; bot.x = p.x; bot.z = p.z; bot.y = BOT_REST_Y; bot.vy = 0; bot.stunnedUntil = 0;
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

setInterval(() => {   // 1秒ごとに、時間がたった箱を閉める
  const now = Date.now();
  let changed = false, nChanged = false;
  fxChests.forEach((c) => { if (c.open && now >= c.reopenAt) { c.open = false; changed = true; } });
  fxNChests.forEach((c) => { if (c.open && now >= c.reopenAt) { c.open = false; nChanged = true; } });
  if (changed) io.emit('fxChestState', { open: fxOpenChestIds() });
  if (nChanged) io.emit('fxNChestState', { open: fxNChestList() });
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

const ORBITAL_TYPES = ['nuke', 'nuke1', 'nuke3', 'nuke5', 'stab', 'railgun'];   // nuke ＝ レベル2（今までの強さ）

io.on('connection', (socket) => {
  const on = function (ev, fn) { socket.on(ev, guard(ev, fn)); };

  // 「新しいサーバーです」と知らせる（クライアントは、これが届いた時だけ、新しい機能を使います）
  socket.emit('fxServerInfo', { v: SERVER_VERSION, nChests: FX_NCHEST_COUNT });

  on('join', (d) => {
    players[socket.id] = {
      id: (d && d.deviceId) || socket.id,
      name: String((d && d.name) || 'プレイヤー').slice(0, 24),
      x: ONLINE_TOWER.x, y: SPAWN_Y, z: ONLINE_TOWER.z, yaw: 0, pitch: 0,
      weaponId: 'pistol', health: 100, armor: '0,0,0,0', crouching: false,
      velX: 0, velZ: 0, lastUpdateT: 0
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
    if (ORBITAL_TYPES.indexOf(orbitalType) < 0) return;   // ★nuke1/3/5・railgun も渡せる
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
        const moved = resolveBotMove(bot.x, bot.z, bot.x + (dx / horizLen) * 0.5, bot.z + (dz / horizLen) * 0.5);
        bot.x = moved.x; bot.z = moved.z;
      }

      if (now - bot.lastShot > 1500) {
        bot.lastShot = now;
        const bulletSpeed = BOT_WEAPON_SPEED[bot.weaponId] || 55;
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
          if (hitDist < 2.2) {
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
      const moved = resolveBotMove(bot.x, bot.z, bot.x + (dx / len) * 0.2, bot.z + (dz / len) * 0.2);
      bot.x = moved.x; bot.z = moved.z;
    }
  }
}, 200);

// どこかで想定外のエラーが起きても、サーバー全体は止めない（Render のログに出るだけ）
process.on('uncaughtException', (e) => { console.error('[想定外のエラー]', e && e.message); });
process.on('unhandledRejection', (e) => { console.error('[想定外のエラー]', e && e.message ? e.message : e); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('KP銃ゲー オンラインサーバー（ver.8）起動しました。ポート: ' + PORT));
