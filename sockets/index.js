/**
 * sockets/index.js — All socket handlers in one file.
 *
 * Exports a single function: registerAllSocketHandlers(socket, io, rooms, nameIndex)
 *
 * Sections:
 *   NTP          — clock sync
 *   Sync         — play / pause / stop / seek
 *   File         — WebRTC relay + file:ready + listener:name
 *   Chat         — text messages, voice, reactions
 *   Aux          — aux cord request / handover / reclaim
 *   Analytics    — session stats, leaderboard, proom:status
 *   Disconnect   — room expiry on disconnect
 *
 * Room lifecycle (create / join / leave / rejoin) stays in room.js
 * because it is also imported by server.js for genCode / simpleHash.
 */
'use strict';

const db = require('../db');
const { deleteR2Object } = require('../routes/r2');
const { snapshot, MAX_LISTENERS } = require('./room');

function registerAllSocketHandlers(socket, io, rooms, nameIndex) {
  const user = socket.request?.user;

  // ═══════════════════════════════════════════════════════════
  // NTP — 4-step clock sync
  // ═══════════════════════════════════════════════════════════
  socket.on('ntp:req', ({ t1 }) => {
    const t2 = Date.now();
    setImmediate(() => socket.emit('ntp:res', { t1, t2, t3: Date.now() }));
  });

  // ═══════════════════════════════════════════════════════════
  // SYNC — playback commands
  // ═══════════════════════════════════════════════════════════
  socket.on('sync:play', ({ position = 0 }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    io.to(room.code).emit('sync:play', { playAt: Date.now() + 400, position });
  });

  socket.on('sync:pause', () => {
    const c = socket.data.code;
    if (c) socket.to(c).emit('sync:pause');
  });

  socket.on('sync:stop', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    room.fileHash = null;
    room.readySet = new Set();
    io.to(room.code).emit('sync:stop');
    io.to(room.code).emit('room:state', snapshot(room));
  });

  socket.on('sync:seek', ({ position }) => {
    const c = socket.data.code;
    if (c) io.to(c).emit('sync:seek', { position, seekAt: Date.now() });
  });

  // ═══════════════════════════════════════════════════════════
  // FILE — WebRTC signalling + relay + file:ready
  // ═══════════════════════════════════════════════════════════
  ['rtc:offer', 'rtc:answer', 'rtc:ice'].forEach(ev =>
    socket.on(ev, d => io.to(d.to).emit(ev, { ...d, from: socket.id }))
  );

  socket.on('file:meta', d => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    room.fileHash  = d.hash;
    room.readySet  = new Set();
    room._relayBuf = null;
    socket.to(room.code).emit('file:meta', d);
  });

  socket.on('file:relay-start', ({ name, size, hash, total, compressed }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    socket.to(room.code).emit('file:relay-start', { name, size, hash, total, compressed });
  });

  socket.on('file:relay-chunk', ({ seq, data, total }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    socket.to(room.code).emit('file:relay-chunk', { seq, data, total });
  });

  socket.on('file:relay-done', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    socket.to(room.code).emit('file:relay-done');
  });

  socket.on('file:ready', async ({ hash }) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.masterSid || hash !== room.fileHash) return;
    room.readySet.add(socket.id);

    // 100 pts to host on first listener confirm
    if (room.readySet.size === 1) {
      const mSock = io.sockets.sockets.get(room.masterSid);
      const hUser = mSock?.request?.user;
      if (hUser?.id) {
        db.addPoints(hUser.id, 'song', 100).catch(() => {});
        db.incrementCounter(hUser.id, 'songs_shared').catch(() => {});
        db.getLeaderboard(room.code).then(board =>
          io.to(room.code).emit('leaderboard:data', { board })
        ).catch(() => {});
      }
    }

    const snap = snapshot(room);
    io.to(room.masterSid).emit('file:ready', {
      peerSid: socket.id, readyCount: snap.readyCount,
      allReady: snap.allReady, listenerCount: snap.listenerCount,
    });
    io.to(room.code).emit('room:state', snap);

    // R2 auto-deletion
    if (room._r2Key) {
      room._r2ReadyCount = (room._r2ReadyCount || 0) + 1;
      const expected = room._r2ExpectedCount || room.followers.size;
      if (room._r2ReadyCount >= expected) {
        clearTimeout(room._r2DeleteTimer);
        const key = room._r2Key;
        room._r2Key = null;
        deleteR2Object(key);
      }
    }
  });

  socket.on('listener:name', ({ displayName }) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.followers.has(socket.id)) return;
    const safeName = (displayName || '').trim().slice(0, 32) || 'Listener';
    room.followers.get(socket.id).displayName = safeName;
    if (room.masterSid) io.to(room.masterSid).emit('listener:name', { peerSid: socket.id, displayName: safeName });
    socket.emit('listener:name-ack', { displayName: safeName });
  });

  // ═══════════════════════════════════════════════════════════
  // CHAT — text, voice, reactions
  // ═══════════════════════════════════════════════════════════
  socket.on('chat:voice', async ({ data, duration, systemAudio, replyToId, replyText, replySender }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || !data) return;
    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName || follower?.name || user?.name || 'Guest';
    const role       = room.masterSid === socket.id ? 'master' : 'follower';
    const payload = {
      sid: socket.id, senderName, role, ts: Date.now(),
      voiceData: data, duration, systemAudio: !!systemAudio,
      replyToId: replyToId || null, replyText: replyText || null, replySender: replySender || null,
      text: systemAudio ? '[System audio]' : '[Voice message]',
    };
    io.to(code).emit('chat:message', payload);
    const logEntry = { ...payload, voiceData: undefined };
    room.chatLog.push(logEntry);
    if (room.chatLog.length > 100) room.chatLog.shift();
    db.saveChat(code, { sid: socket.id, senderName, role, text: logEntry.text }).catch(() => {});
    if (user?.id) {
      db.addPoints(user.id, 'voice', 5).catch(() => {});
      const board = await db.getLeaderboard(code).catch(() => []);
      io.to(code).emit('leaderboard:data', { board });
    }
  });

  socket.on('chat:send', async ({ text, replyToId: rToId, replyText: rText, replySender: rSender }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || !text) return;
    const msg = (text || '').trim().slice(0, 280);
    if (!msg) return;
    const follower   = room.followers.get(socket.id);
    // For master socket: use authenticated user name directly (not in followers map)
    const senderName = follower?.displayName || follower?.name || user?.name
      || (room.masterSid === socket.id ? 'Host' : 'Listener');
    const role      = room.masterSid === socket.id ? 'master' : 'follower';
    const replyToId = typeof rToId === 'number' ? rToId : null;
    const payload   = {
      sid: socket.id, senderName, role, text: msg, ts: Date.now(),
      replyToId, replyText: rText || null, replySender: rSender || null,
    };
    io.to(code).emit('chat:message', payload);
    room.chatLog.push(payload);
    if (room.chatLog.length > 100) room.chatLog.shift();
    db.saveChat(room.code, { sid: socket.id, senderName, role, text: msg,
      replyToId, replyText: rText || null, replySender: rSender || null,
    }).then(id => { payload.id = id; }).catch(() => {});
    if (user?.id) {
      const wordCount  = msg.trim().split(/\s+/).filter(Boolean).length;
      const replyBonus = replyToId ? 5 : 0;
      if (wordCount)  db.addPoints(user.id, 'word', wordCount).catch(() => {});
      if (replyBonus) db.addPoints(user.id, 'reply', replyBonus).catch(() => {});
      db.incrementCounter(user.id, 'messages_sent').catch(() => {});
      const board = await db.getLeaderboard(code).catch(() => []);
      io.to(code).emit('leaderboard:data', { board });
    }
  });

  socket.on('reaction:send', async ({ emoji }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || !emoji || emoji.length > 8) return;
    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName || follower?.name || user?.name || 'Someone';
    io.to(code).emit('reaction:broadcast', { emoji, senderName, sid: socket.id, ts: Date.now() });
    const rxnMsg = {
      sid: socket.id, senderName, role: socket.data.role || 'follower',
      text: senderName + ' reacted ' + emoji, ts: Date.now(), isReaction: true, emoji,
    };
    room.chatLog.push(rxnMsg);
    if (room.chatLog.length > 100) room.chatLog.shift();
    db.saveChat(code, { sid: socket.id, senderName, role: rxnMsg.role, text: rxnMsg.text }).catch(() => {});
    if (user?.id) {
      db.addPoints(user.id, 'reaction', 10).catch(() => {});
      db.incrementCounter(user.id, 'reactions_sent').catch(() => {});
      db.addReactionLog(code, user.id, senderName, emoji).catch(() => {});
      const board = await db.getLeaderboard(code).catch(() => []);
      io.to(code).emit('leaderboard:data', { board });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // AUX CORD — host handover
  // ═══════════════════════════════════════════════════════════
  socket.on('seek:request', ({ position }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid === socket.id) return;
    const f = room.followers.get(socket.id);
    if (room.masterSid)
      io.to(room.masterSid).emit('seek:request', {
        from: socket.id, senderName: f?.displayName || f?.name || 'A listener', position,
      });
  });

  socket.on('seek:respond', ({ to, approved, position }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    io.to(to).emit('seek:response', { approved, position });
    if (approved) io.to(room.code).emit('sync:seek', { position, seekAt: Date.now() });
  });

  socket.on('aux:request', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid === socket.id || !room.masterSid) return;
    const f    = room.followers.get(socket.id);
    const name = f?.displayName || f?.name || 'A listener';
    room.pendingAuxReq = { fromSid: socket.id, fromName: name };
    io.to(room.masterSid).emit('aux:request', { fromSid: socket.id, fromName: name });
  });

  socket.on('aux:respond', ({ approved }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    const req = room.pendingAuxReq;
    room.pendingAuxReq = null;
    if (!req) return;
    if (!approved) { io.to(req.fromSid).emit('aux:denied'); return; }

    const oldHostName = room.followers.get(socket.id)?.displayName || user?.name || 'Host';
    const newHostName = req.fromName;

    room.followers.set(socket.id, { name: oldHostName, displayName: oldHostName });
    socket.data.role = 'follower';
    room.masterSid   = req.fromSid;
    room.fileHash    = null;
    room.readySet    = new Set();

    const newSock = io.sockets.sockets.get(req.fromSid);
    if (newSock) { room.followers.delete(req.fromSid); newSock.data.role = 'master'; }

    const followerSids = [...room.followers.keys()];
    io.to(req.fromSid).emit('aux:granted', {
      newRole: 'master', isOwner: room.ownerSid === req.fromSid,
      ownerSid: room.ownerSid, ownerName: room.ownerName,
      followerSids, listenerCount: room.followers.size,
    });
    socket.emit('aux:role-changed', { newRole: 'follower', isOwner: room.ownerSid === socket.id, newHostName });
    socket.to(room.code).emit('aux:host-changed', {
      newHostSid: req.fromSid, newHostName, oldHostName,
      isOwner: room.ownerSid === req.fromSid, ownerSid: room.ownerSid,
    });
    const chatMsg = { sid: 'system', senderName: 'System', role: 'system',
      text: `${oldHostName} handed the aux to ${newHostName} 🎸`, ts: Date.now() };
    room.chatLog.push(chatMsg);
    io.to(room.code).emit('chat:message', chatMsg);
  });

  socket.on('aux:reclaim', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.ownerSid !== socket.id || room.masterSid === socket.id) return;
    room.pendingAuxReq = null;
    const oldHostName = room.followers.get(room.masterSid)?.displayName || 'the current host';
    const ownerName   = room.followers.get(socket.id)?.displayName || user?.name || room.ownerName || 'Room owner';

    const curSock = io.sockets.sockets.get(room.masterSid);
    if (curSock) {
      room.followers.set(room.masterSid, { name: oldHostName, displayName: oldHostName });
      curSock.data.role = 'follower';
      curSock.emit('aux:role-changed', { newRole: 'follower', isOwner: false, newHostName: ownerName });
    }
    room.masterSid = socket.id;
    room.fileHash  = null;
    room.readySet  = new Set();
    room.followers.delete(socket.id);
    socket.data.role = 'master';

    socket.emit('aux:granted', {
      newRole: 'master', isOwner: true,
      ownerSid: room.ownerSid, ownerName: room.ownerName,
      followerSids: [...room.followers.keys()], listenerCount: room.followers.size,
    });
    const chatMsg = { sid: 'system', senderName: 'System', role: 'system',
      text: `${ownerName} reclaimed the aux cord 🎤`, ts: Date.now() };
    room.chatLog.push(chatMsg);
    io.to(room.code).emit('chat:message', chatMsg);
    io.to(room.code).emit('aux:host-changed', {
      newHostSid: socket.id, newHostName: ownerName, oldHostName,
      isOwner: true, ownerSid: room.ownerSid,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // ANALYTICS — session tracking, leaderboard, proom status
  // ═══════════════════════════════════════════════════════════
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
      if (user?.id) db.incrementSessions(user.id, 'master').catch(() => {});
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
      code, live: !!live, hostOnline: !!(live?.masterSid),
      listenerCount: live?.followers.size || 0,
    });
  });

  socket.on('leaderboard:get', async () => {
    const code = socket.data.code;
    if (!code) return;
    try {
      // Collect user IDs of all live room participants so they show on
      // the board immediately even before earning any points
      const room = rooms.get(code);
      // Collect unique user IDs — same user on 2 tabs has same user.id
      const liveUserIdSet = new Set();
      if (room) {
        const allSids = [room.masterSid, ...room.followers.keys()].filter(Boolean);
        for (const sid of allSids) {
          const s = io.sockets.sockets.get(sid);
          if (s?.request?.user?.id) liveUserIdSet.add(s.request.user.id);
        }
      }
      const liveUserIds = [...liveUserIdSet];
      const [board, reactions] = await Promise.all([
        db.getLeaderboardLive(code, liveUserIds, 20),
        db.getRoomReactions(code, 50),
      ]);
      socket.emit('leaderboard:data', { board, reactions });
    } catch(e) { console.warn('[leaderboard]', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  // DISCONNECT — room expiry
  // ═══════════════════════════════════════════════════════════
  socket.on('disconnect', () => {
    const { code, role } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    console.log(`[ws] - ${socket.id.slice(0, 8)} (${role}) from ${code}`);

    if (role === 'master') {
      room.masterSid = null;
      clearTimeout(room._masterTimeout);
      room._masterTimeout = setTimeout(() => {
        if (room._r2Key) {
          clearTimeout(room._r2DeleteTimer);
          deleteR2Object(room._r2Key);
          room._r2Key = null;
        }
        nameIndex.delete(room.name.toLowerCase());
        rooms.delete(code);
        io.to(code).emit('peer:left', { role: 'master', permanent: true });
        console.log(`[room] expired "${room.name}" (no host reconnect)`);
      }, 10 * 60 * 1000);
      socket.to(code).emit('peer:left', { role: 'master', permanent: false });
    } else {
      room.followers.delete(socket.id);
      room.readySet.delete(socket.id);
      if (room.masterSid)
        io.to(room.masterSid).emit('peer:left', {
          role: 'follower', peerSid: socket.id, permanent: false,
          listenerCount: room.followers.size,
        });
      io.to(code).emit('room:state', snapshot(room));
    }
  });
}

module.exports = { registerAllSocketHandlers };
