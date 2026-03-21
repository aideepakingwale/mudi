/**
 * sockets/sync.js — Playback sync + NTP clock handlers
 *
 * Events: ntp:req, sync:play, sync:pause, sync:stop, sync:seek
 */
'use strict';

function registerSyncHandlers(socket, io, rooms) {

  // ── NTP ───────────────────────────────────────────────────────────────────
  socket.on('ntp:req', ({ t1 }) => {
    const t2 = Date.now();
    setImmediate(() => socket.emit('ntp:res', { t1, t2, t3: Date.now() }));
  });

  // ── sync:play ─────────────────────────────────────────────────────────────
  socket.on('sync:play', ({ position = 0 }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    io.to(room.code).emit('sync:play', { playAt: Date.now() + 400, position });
  });

  // ── sync:pause ────────────────────────────────────────────────────────────
  socket.on('sync:pause', () => {
    const c = socket.data.code;
    if (c) socket.to(c).emit('sync:pause');
  });

  // ── sync:stop ─────────────────────────────────────────────────────────────
  socket.on('sync:stop', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    room.fileHash = null;
    room.readySet = new Set();
    io.to(room.code).emit('sync:stop');
    const { snapshot } = require('./room');
    io.to(room.code).emit('room:state', snapshot(room));
  });

  // ── sync:seek ─────────────────────────────────────────────────────────────
  socket.on('sync:seek', ({ position }) => {
    const c = socket.data.code;
    if (c) io.to(c).emit('sync:seek', { position, seekAt: Date.now() });
  });
}

module.exports = { registerSyncHandlers };
