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
const BOT_WEAPON_SPEED = { pistol: 55, rifle: 65 }; // 先読み計算用のおおよその弾速
const FIELD_HALF = 105;
const TOWER_SAFE_Y = 20;

function randomSpot() {
  return { x: (Math.random() - 0.5) * FIELD_HALF * 1.7, z: (Math.random() - 0.5) * FIELD_HALF * 1.7 };
}

const bots = [];
function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const p = randomSpot();
    bots.push({ id: 'bot_' + i, x: p.x, y: 1.3, z: p.z, targetX: p.x, targetZ: p.z, health: 100, weaponId: BOT_WEAPONS[i % BOT_WEAPONS.length], lastShot: 0 });
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
    const payload = {
      damage: d.damage,
      attackerName: attacker ? attacker.name : '???',
      attackerId: socket.id
    };
    if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      payload.kbX = d.kbX; payload.kbZ = d.kbZ; payload.kbForce = d.kbForce; payload.kbVertical = !!d.kbVertical;
    }
    io.to(d.targetId).emit('youWereHit', payload);
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
    if (bot.health <= 0) {
      const attacker = players[socket.id];
      io.emit('botKilled', { botId: bot.id, killerId: socket.id, killerName: attacker ? attacker.name : '???' });
      setTimeout(() => {
        const p = randomSpot();
        bot.health = 100; bot.x = p.x; bot.z = p.z;
        bot.weaponId = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)];
      }, 6000);
    } else if (typeof d.kbX === 'number' && typeof d.kbZ === 'number') {
      bot.x += d.kbX * (d.kbForce || 2);
      bot.z += d.kbZ * (d.kbForce || 2);
    }
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

  socket.on('chatMessage', (d) => {
    const p = players[socket.id];
    const text = String((d && d.text) || '').slice(0, 200);
    if (!text) return;
    socket.broadcast.emit('chatBroadcast', { name: p ? p.name : '???', text: text });
  });

  socket.on('disconnect', () => {
    console.log('退出:', players[socket.id] ? players[socket.id].name : socket.id);
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

setInterval(() => {
  io.emit('playersUpdate', players);
  io.emit('botsUpdate', bots.filter(b => b.health > 0).map(b => ({ id: b.id, x: b.x, y: b.y, z: b.z, weaponId: b.weaponId })));
}, 100);

setInterval(() => {
  const now = Date.now();
  for (const bot of bots) {
    if (bot.health <= 0) continue;

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
      if (horizLen > 8) { bot.x += (dx / horizLen) * 0.5; bot.z += (dz / horizLen) * 0.5; }

      if (now - bot.lastShot > 1500) {
        bot.lastShot = now;

        const bulletSpeed = BOT_WEAPON_SPEED[bot.weaponId] || 55;
        const travelTime = nearestDist / bulletSpeed;
        const leadX = nearest.x + (nearest.velX || 0) * travelTime * 0.9;
        const leadZ = nearest.z + (nearest.velZ || 0) * travelTime * 0.9;

        const tdx = leadX - bot.x, tdy = (nearest.y + 0.9) - (bot.y + 1.3), tdz = leadZ - bot.z;
        const tlen = Math.sqrt(tdx*tdx + tdy*tdy + tdz*tdz) || 1;
        const spread = 0.05;
        let aimX = tdx / tlen + (Math.random() - 0.5) * spread;
        let aimY = tdy / tlen + (Math.random() - 0.5) * spread;
        let aimZ = tdz / tlen + (Math.random() - 0.5) * spread;
        const alen = Math.sqrt(aimX*aimX + aimY*aimY + aimZ*aimZ) || 1;
        aimX /= alen; aimY /= alen; aimZ /= alen;

        io.emit('remoteShotFired', { originX: bot.x, originY: bot.y + 1.3, originZ: bot.z, dirX: aimX, dirY: aimY, dirZ: aimZ, weaponId: bot.weaponId });

        const dot = (aimX*tdx + aimY*tdy + aimZ*tdz) / tlen;
        if (dot > 0.975) {
          io.to(nearestSid).emit('youWereHit', { damage: 6, attackerName: '🤖 Bot', attackerId: null });
        }
      }
    } else {
      if (Math.hypot(bot.targetX - bot.x, bot.targetZ - bot.z) < 1) {
        const p = randomSpot(); bot.targetX = p.x; bot.targetZ = p.z;
      }
      const dx = bot.targetX - bot.x, dz = bot.targetZ - bot.z;
      const len = Math.hypot(dx, dz) || 1;
      bot.x += (dx / len) * 0.2; bot.z += (dz / len) * 0.2;
    }
  }
}, 200);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('KP銃ゲー オンラインサーバー起動しました。ポート: ' + PORT));
