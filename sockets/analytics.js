/**
 * sockets/analytics.js — Session analytics, leaderboard, permanent room status
 *
 * Events: analytics:session-start, analytics:session-end,
 *         proom:status, leaderboard:get
 */
'use strict';

const db = require('../db');

function registerAnalyticsHandlers(socket, io, rooms) {
  const user = socket.request?.user;

  socket.on('analytics:session-start', async ({ fileName, fileSize, transferMode }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    try {
      const sessionId = await db.startSession({
        roomCode: room.code, roomName: room.name,
        hostId: user?.id, listenerCount: room.followers.size,
        fileName, fileSize, transferMode,
      });
      room._sessionId    = sessionId;
      room._sessionStart = Date.now();
      if (user?.id) db.incrementSessions(user.id, 'master').catch(()=>{});
    } catch(e) { console.warn('[analytics]', e.message); }
  });

  socket.on('analytics:session-end', async ({ syncCorrections }) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room._sessionId) return;
    try {
      const dur = Math.round((Date.now() - (room._sessionStart || Date.now())) / 1000);
      await db.endSession(room._sessionId, { syncCorrections, durationSecs: dur });
      room._sessionId = null;
    } catch(e) { console.warn('[analytics]', e.message); }
  });

  socket.on('proom:status', ({ code }) => {
    const live = rooms.get((code || '').toUpperCase());
    socket.emit('proom:status-res', {
      code,
      live:          !!live,
      hostOnline:    !!(live?.masterSid),
      listenerCount: live?.followers.size || 0,
    });
  });

  socket.on('leaderboard:get', async () => {
    const code = socket.data.code;
    if (!code) return;
    try {
      const [board, reactions] = await Promise.all([
        db.getLeaderboard(code, 20),
        db.getRoomReactions(code, 50),
      ]);
      socket.emit('leaderboard:data', { board, reactions });
    } catch(e) { console.warn('[leaderboard]', e.message); }
  });
}

module.exports = { registerAnalyticsHandlers };
