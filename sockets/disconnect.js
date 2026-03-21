/**
 * sockets/disconnect.js — Socket disconnect and display-name handlers
 *
 * Events: disconnect, listener:name (display name on join — not file transfer)
 */
'use strict';

const { deleteR2Object } = require('../routes/r2');
const { snapshot, MAX_LISTENERS } = require('./room');

function registerDisconnectHandler(socket, io, rooms, nameIndex) {

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

module.exports = { registerDisconnectHandler };
