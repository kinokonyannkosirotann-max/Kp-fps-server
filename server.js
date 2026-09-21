// ==========================================
// KP銃ゲー オンライン対戦サーバー
// ==========================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => res.send('KP銃ゲー オンラインサーバー 稼働中です'));

const players = {};
const BOT_COUNT = 2;
const BOT_WEAPONS = ['pistol', 'rifle'];
const BOT_WEAPON_SPEED = { pistol: 55, rifle: 65 };
const FIELD_HALF = 105;
const TOWER_SAFE_Y = 20;
const ONLINE_TOWER = { x: 0, z: 0 };

function randomSpot() {
  return { x: (Math.random() - 0.5) * FIELD_HALF * 1.7, z: (Math.random() - 0.5) * FIELD_HALF * 1.7 };
}

// ---- クライアントのfpsMakeSeededRandomと完全に同じアルゴリズム。値も必ず同じにしてください ----
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

// Botが避ける「地面から天井まで塞がっている大きい建物」だけの簡易リスト
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

// ---- 箱（クレート）：サーバーだけが状態を持ち、全員に同じものを見せる ----
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

const bots = [];
function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const p = randomSpot();
    bots.push({ id: 'bot_' + i, x: p.x, y: 1.3, z: p.z, targetX: p.x, targetZ: p.z, health: 100, weaponId: BOT_WEAPONS[i % BOT_WEAPONS.length], lastShot: 0, stunnedUntil: 0 });
  }
}
initBots();

io.on('connection', (socket) => {
  socket.on('join', (d) => {
    const spawn = randomSpot();
    players[socket.id] = {
      id: (d && d.deviceId) || socket.id,
      name: (d && d.name) || 'プレイヤー',
      x: spawn.x, y: 28, z: spawn.z, yaw: 0,
      weaponId: 'pistol', health: 100,
      velX: 0, velZ: 0, lastUpdateT: 0
    };
    console.log('参加:', players[socket.id].name);
    socket.emit('crateUpdate', onlineCrates);
  });

  socket.on('updateState', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
    const now = Date.now();
    if (p.lastUpdateT) {
      const dtSec = Math.max(0.02, (now - p.lastUpdateT) / 1000);
      p.velX = (d.x - p.x) / dtSec;
      p.velZ = (d.z - p.z) / dtSec;
    }
    p.lastUpdateT = now;
    p.x = d.x; p.y = d.y; p.z = d.z; p.yaw = d.yaw;
    p.weaponId = d.weaponId; p.health = d.health;
  });

  socket.on('shotFired', (d) => {
    socket.broadcast.emit('remoteShotFired', d);
  });

  socket.on('hitPlayer', (d) => {
    if (!d || !d.targetId) return;
    const attacker = players[socket.id];
    const payload = { damage: d.damage, attackerName: attacker ? attacker.name : '???', attackerId: socket.id };
    if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      payload.kbX = d.kbX; payload.kbZ = d.kbZ; payload.kbForce = d.kbForce; payload.kbVertical = !!d.kbVertical;
    }
    if (d.stunMs) payload.stunMs = d.stunMs;
    io.to(d.targetId).emit('youWereHit', payload);
    io.emit('playerHitFlash', { targetId: d.targetId });
  });
  
  socket.on('playerDied', (d) => {
    const victim = players[socket.id];
    io.emit('killFeed', {
      victimId: socket.id,
      victimName: victim ? victim.name : '???',
      killerId: (d && d.killerId) || null,
      killerName: (d && d.killerName) || null
    });
  });

  socket.on('hitBot', (d) => {
    const bot = bots.find(b => b.id === d.botId);
    if (!bot || bot.health <= 0) return;
    bot.health -= d.damage;
    if (d.stunMs) bot.stunnedUntil = Date.now() + d.stunMs;
    io.emit('botHitFlash', { botId: bot.id }); 
    if (bot.health <= 0) {
      const attacker = players[socket.id];
      io.emit('botKilled', { botId: bot.id, killerId: socket.id, killerName: attacker ? attacker.name : '???' });
      setTimeout(() => {
        const p = randomSpot();
        bot.health = 100; bot.x = p.x; bot.z = p.z; bot.stunnedUntil = 0;
        bot.weaponId = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)];
      }, 6000);
    } else if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
          } else {
      io.emit('botHitFlash', { botId: bot.id });
      if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
        bot.x += d.kbX * (d.kbForce || 2);
        bot.z += d.kbZ * (d.kbForce || 2);
      }
    }
  });

  socket.on('breakCrate', (d) => {
    const crate = onlineCrates.find(c => c.id === d.crateId);
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

  socket.on('kickPlayer', (d) => {
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
    if (targetSid) {
      io.to(targetSid).emit('youWereKicked', {});
      const s = io.sockets.sockets.get(targetSid);
      if (s) s.disconnect(true);
    }
  });
  
socket.on('grantOrbital', (d) => {
    const targetName = String((d && d.targetName) || '').trim().toLowerCase();
    const orbitalType = String((d && d.orbitalType) || '').trim().toLowerCase();
    if (orbitalType !== 'nuke' && orbitalType !== 'stab') return;
    const targetSid = Object.keys(players).find(sid => players[sid].name.toLowerCase() === targetName);
    if (targetSid) {
      io.to(targetSid).emit('orbitalGranted', { orbitalType: orbitalType, granterName: (d && d.granterName) || '誰か' });
    }
  });

  socket.on('meleeSwing', (d) => {
    socket.broadcast.emit('remoteMeleeSwing', { playerId: socket.id, weaponId: d && d.weaponId });
  });
  
  socket.on('chatMessage', (d) => {
    const p = players[socket.id];
    const text = String((d && d.text) || '').slice(0, 200);
    if (!text) return;
    socket.broadcast.emit('chatBroadcast', { name: p ? p.name : '???', text: text });
  });

  socket.on('chatJoin', (d) => {
    const permId = String((d && d.id) || '').trim().toLowerCase();
    if (!permId) return;
    chatOnlineUsers[permId] = socket.id;
  });

  socket.on('dmMessage', (d) => {
    if (!d || !d.targetId) return;
    const targetPermId = String(d.targetId).trim().toLowerCase();
    const targetSocketId = chatOnlineUsers[targetPermId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('dmMessage', { senderId: d.senderId, senderName: d.senderName, text: d.text });
    }
  });

  socket.on('groupMessage', (d) => {
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

  socket.on('disconnect', () => {
    console.log('退出:', players[socket.id] ? players[socket.id].name : socket.id);
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
    for (const permId in chatOnlineUsers) {
      if (chatOnlineUsers[permId] === socket.id) { delete chatOnlineUsers[permId]; break; }
    }
  });
});

const chatOnlineUsers = {};

setInterval(() => {
  io.emit('playersUpdate', players);
  io.emit('botsUpdate', bots.filter(b => b.health > 0).map(b => ({ id: b.id, x: b.x, y: b.y, z: b.z, weaponId: b.weaponId })));
}, 100);

// Botの簡易AI（0.2秒ごと）
setInterval(() => {
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
          if (hitDist < 1.3) {
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('KP銃ゲー オンラインサーバー起動しました。ポート: ' + PORT));
