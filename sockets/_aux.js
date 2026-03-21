/**
 * sockets/aux.js — Aux cord transfer (host handover between participants)
 *
 * Events: aux:request, aux:respond, aux:reclaim,
 *         seek:request, seek:respond
 */
'use strict';

const db = require('../db');

function registerAuxHandlers(socket, io, rooms) {

  // ── seek:request — listener asks host to jump to a position ──────────────
  socket.on('seek:request', ({ position }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid === socket.id) return;
    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName || follower?.name || 'A listener';
    if (room.masterSid)
      io.to(room.masterSid).emit('seek:request', { from: socket.id, senderName, position });
  });

  // ── seek:respond — host approves or denies a seek request ─────────────────
  socket.on('seek:respond', ({ to, approved, position }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    io.to(to).emit('seek:response', { approved, position });
    if (approved)
      io.to(room.code).emit('sync:seek', { position, seekAt: Date.now() });
  });

  // ── aux:request — listener asks for the aux cord ──────────────────────────
  socket.on('aux:request', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid === socket.id || !room.masterSid) return;
    const follower   = room.followers.get(socket.id);
    const name       = follower?.displayName || follower?.name || 'A listener';
    room.pendingAuxReq = { fromSid: socket.id, fromName: name };
    io.to(room.masterSid).emit('aux:request', { fromSid: socket.id, fromName: name });
    console.log('[aux] request from', name);
  });

  // ── aux:respond — current host approves or denies the request ─────────────
  socket.on('aux:respond', async ({ approved }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.masterSid !== socket.id) return;
    const req = room.pendingAuxReq;
    room.pendingAuxReq = null;
    if (!req) return;

    if (!approved) {
      io.to(req.fromSid).emit('aux:denied');
      return;
    }

    const oldHostName = room.followers.get(socket.id)?.displayName || socket.request?.user?.name || 'Host';
    const newHostName = req.fromName;

    // Demote current master → follower
    room.followers.set(socket.id, { name: oldHostName, displayName: oldHostName });
    socket.data.role = 'follower';

    // Promote requester → master
    room.masterSid = req.fromSid;
    room.fileHash  = null;
    room.readySet  = new Set();
    const newHostSocket = io.sockets.sockets.get(req.fromSid);
    if (newHostSocket) {
      room.followers.delete(req.fromSid);
      newHostSocket.data.role = 'master';
    }

    const followerSids = [...room.followers.keys()];

    io.to(req.fromSid).emit('aux:granted', {
      newRole: 'master',
      isOwner: room.ownerSid === req.fromSid,
      ownerSid: room.ownerSid,
      ownerName: room.ownerName,
      followerSids,
      listenerCount: room.followers.size,
    });

    socket.emit('aux:role-changed', {
      newRole: 'follower',
      isOwner: room.ownerSid === socket.id,
      newHostName,
    });

    socket.to(room.code).emit('aux:host-changed', {
      newHostSid: req.fromSid, newHostName,
      oldHostName, isOwner: room.ownerSid === req.fromSid,
      ownerSid: room.ownerSid,
    });

    const chatMsg = {
      sid: 'system', senderName: 'System', role: 'system',
      text: `${oldHostName} handed the aux to ${newHostName} 🎸`,
      ts: Date.now(),
    };
    room.chatLog.push(chatMsg);
    io.to(room.code).emit('chat:message', chatMsg);
    console.log('[aux] transferred from', oldHostName, 'to', newHostName);
  });

  // ── aux:reclaim — room owner takes back the aux cord from anyone ──────────
  socket.on('aux:reclaim', async () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.ownerSid !== socket.id || room.masterSid === socket.id) return;

    room.pendingAuxReq = null;
    const oldHostName = room.followers.get(room.masterSid)?.displayName || 'the current host';
    const ownerName   = room.followers.get(socket.id)?.displayName
      || socket.request?.user?.name || room.ownerName || 'Room owner';

    // Demote current master
    const currentHostSocket = io.sockets.sockets.get(room.masterSid);
    if (currentHostSocket) {
      room.followers.set(room.masterSid, { name: oldHostName, displayName: oldHostName });
      currentHostSocket.data.role = 'follower';
      currentHostSocket.emit('aux:role-changed', {
        newRole: 'follower', isOwner: false, newHostName: ownerName,
      });
    }

    // Promote owner
    room.masterSid = socket.id;
    room.fileHash  = null;
    room.readySet  = new Set();
    room.followers.delete(socket.id);
    socket.data.role = 'master';

    const followerSids = [...room.followers.keys()];
    socket.emit('aux:granted', {
      newRole: 'master', isOwner: true,
      ownerSid: room.ownerSid, ownerName: room.ownerName,
      followerSids, listenerCount: room.followers.size,
    });

    const chatMsg = {
      sid: 'system', senderName: 'System', role: 'system',
      text: `${ownerName} reclaimed the aux cord 🎤`,
      ts: Date.now(),
    };
    room.chatLog.push(chatMsg);
    io.to(room.code).emit('chat:message', chatMsg);
    io.to(room.code).emit('aux:host-changed', {
      newHostSid: socket.id, newHostName: ownerName,
      oldHostName, isOwner: true, ownerSid: room.ownerSid,
    });

    console.log('[aux] reclaimed by owner', ownerName);
  });
}

module.exports = { registerAuxHandlers };
