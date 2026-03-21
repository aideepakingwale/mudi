/**
 * sockets/file.js — File metadata relay and WebRTC/Socket.IO transfer events
 *
 * Events: file:meta, file:relay-start, file:relay-chunk, file:relay-done,
 *         file:ready, listener:name
 *
 * WebRTC signalling relay: rtc:offer, rtc:answer, rtc:ice
 */
'use strict';

const db = require('../db');

function registerFileHandlers(socket, io, rooms) {

  // ── WebRTC signalling (blind relay) ───────────────────────────────────────
  ['rtc:offer', 'rtc:answer', 'rtc:ice'].forEach(ev =>
    socket.on(ev, d => io.to(d.to).emit(ev, { ...d, from: socket.id }))
  );

  // ── file:meta — master announces new file to listeners ────────────────────
  socket.on('file:meta', d => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    room.fileHash  = d.hash;
    room.readySet  = new Set();
    room._relayBuf = null;
    socket.to(room.code).emit('file:meta', d);
  });

  // ── Socket.IO relay chunks (fallback when WebRTC P2P fails) ───────────────
  socket.on('file:relay-start', ({ name, size, hash, total, compressed }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    console.log(`[relay] "${name}" ${(size/1024/1024).toFixed(1)}MB, ${total} chunks`);
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

  // ── file:ready — listener confirms download + hash verified ───────────────
  socket.on('file:ready', async ({ hash }) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.masterSid || hash !== room.fileHash) return;

    room.readySet.add(socket.id);

    // Award 100pts to host when FIRST listener confirms
    if (room.readySet.size === 1) {
      const mSock = io.sockets.sockets.get(room.masterSid);
      const hUser = mSock?.request?.user;
      if (hUser?.id) {
        db.addPoints(hUser.id, 'song', 100).catch(()=>{});
        db.incrementCounter(hUser.id, 'songs_shared').catch(()=>{});
        db.getLeaderboard(room.code).then(board =>
          io.to(room.code).emit('leaderboard:data', { board })
        ).catch(()=>{});
      }
    }

    const { snapshot } = require('./room');
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
      console.log(`[r2] ${room._r2ReadyCount}/${expected} listeners verified download`);
      if (room._r2ReadyCount >= expected) {
        clearTimeout(room._r2DeleteTimer);
        const key = room._r2Key;
        room._r2Key = null;
        const { deleteR2Object } = require('../routes/r2');
        deleteR2Object(key);
      }
    }
  });

  // ── listener:name — follower sets their display name ─────────────────────
  socket.on('listener:name', ({ displayName }) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.followers.has(socket.id)) return;
    const safeName = (displayName || '').trim().slice(0, 32) || 'Listener';
    room.followers.get(socket.id).displayName = safeName;
    io.to(room.masterSid).emit('listener:name', { peerSid: socket.id, displayName: safeName });
    io.to(socket.id).emit('listener:name-ack', { displayName: safeName });
  });
}

module.exports = { registerFileHandlers };
