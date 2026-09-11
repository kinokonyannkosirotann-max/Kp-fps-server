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
      weaponId: 'pistol', health: 100
    };
    console.log('参加:', players[socket.id].name);
  });

  socket.on('updateState', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
    p.x = d.x; p.y = d.y; p.z = d.z; p.yaw = d.yaw;
    p.weaponId = d.weaponId; p.health = d.health;
  });

  socket.on('shotFired', (d) => {
    socket.broadcast.emit('remoteShotFired', d);
  });

  socket.on('hitPlayer', (d) => {
    if (!d || !d.targetId) return;
    const attacker = players[socket.id];
    io.to(d.targetId).emit('youWereHit', {
      damage: d.damage,
      attackerName: attacker ? attacker.name : '???',
      attackerId: socket.id
    });
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
    }
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
      const d = Math.hypot(p.x - bot.x, p.z - bot.z);
      if (d < nearestDist) { nearestDist = d; nearest = p; nearestSid = sid; }
    }
    if (nearest && nearestDist < 35 && nearest.y < TOWER_SAFE_Y) {
      const dx = nearest.x - bot.x, dz = nearest.z - bot.z;
      const len = Math.hypot(dx, dz) || 1;
      if (nearestDist > 8) { bot.x += (dx / len) * 0.5; bot.z += (dz / len) * 0.5; }
      if (now - bot.lastShot > 1800) {
        bot.lastShot = now;
        io.emit('remoteShotFired', { originX: bot.x, originY: bot.y, originZ: bot.z, dirX: dx / len, dirY: 0, dirZ: dz / len, weaponId: bot.weaponId });
        if (Math.random() > 0.55) {
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
