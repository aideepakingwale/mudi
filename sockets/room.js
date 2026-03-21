/**
 * sockets/room.js — Room lifecycle socket handlers
 *
 * Events handled:
 *   room:create, room:check-name, room:join, room:info,
 *   room:leave, room:rejoin
 */
'use strict';

const db = require('../db');

const MAX_LISTENERS = parseInt(process.env.MAX_LISTENERS || '10', 10);

function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const D = '0123456789';
  const r = s => s[Math.random() * s.length | 0];
  return `${r(L)}${r(L)}${r(L)}-${r(D)}${r(D)}${r(D)}`;
}

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function snapshot(room) {
  return {
    code:          room.code,
    name:          room.name,
    listenerCount: room.followers.size,
    maxListeners:  MAX_LISTENERS,
    isFull:        room.followers.size >= MAX_LISTENERS,
    hasPassword:   room.hasPassword,
    fileHash:      room.fileHash,
    readyCount:    room.readySet.size,
    allReady:      room.readySet.size > 0 && room.readySet.size >= room.followers.size,
  };
}

/**
 * Register all room lifecycle handlers for one socket connection.
 * Called once per socket inside io.on('connection').
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {Map} rooms      — shared live room state
 * @param {Map} nameIndex  — lowerName → code
 */
function registerRoomHandlers(socket, io, rooms, nameIndex) {
  const user     = socket.request?.user;
  const userName = user?.name || 'Guest';

  // ── room:create ───────────────────────────────────────────────────────────
  socket.on('room:create', async ({ name, password } = {}) => {
    const roomName = (name || '').trim().slice(0, 32) ||
                     `Room ${Math.floor(Math.random() * 9000) + 1000}`;
    const lc = roomName.toLowerCase();

    if (nameIndex.has(lc)) {
      const existingCode = nameIndex.get(lc);
      const existingRoom = rooms.get(existingCode);
      if (existingRoom) {
        const userId      = user?.id;
        const userIsOwner = userId && existingRoom.ownerUserId === userId;
        const oldSocket   = existingRoom.masterSid
          ? io.sockets.sockets.get(existingRoom.masterSid) : null;
        const masterGone  = !oldSocket || !oldSocket.connected;

        if (userIsOwner || (!existingRoom.masterSid && masterGone)) {
          clearTimeout(existingRoom._masterTimeout);
          existingRoom.masterSid = socket.id;
          existingRoom.ownerSid  = socket.id;
          socket.join(existingCode);
          socket.data.code = existingCode;
          socket.data.role = 'master';
          const chatHistory = await db.getChatHistory(existingCode, 100)
            .catch(() => existingRoom.chatLog || []);
          socket.emit('room:rejoined', {
            code: existingCode, name: existingRoom.name, role: 'master',
            listenerCount: existingRoom.followers.size,
            followerSids:  [...existingRoom.followers.keys()],
            hasFollower:   existingRoom.followers.size > 0,
            fileHash:      existingRoom.fileHash || null,
            readyCount:    existingRoom.readySet.size,
            chatHistory,
            isOwner:       true,
            currentHost:   socket.id,
          });
          [...existingRoom.followers.keys()].forEach(sid =>
            io.to(sid).emit('peer:rejoined', { role: 'master', peerSid: socket.id })
          );
          console.log('[room] owner reclaimed via room:create:', existingRoom.name);
          return;
        }
      }
      return socket.emit('room:err', { msg: `"${roomName}" is already in use. Choose another name.` });
    }

    let code;
    do { code = genCode(); } while (rooms.has(code));

    rooms.set(code, {
      code, name: roomName,
      masterSid:    socket.id,
      ownerSid:     socket.id,
      ownerName:    userName,
      ownerUserId:  user?.id || null,
      followers:    new Map(),
      readySet:     new Set(),
      passwordHash: password ? simpleHash(password.trim()) : null,
      hasPassword:  !!password,
      fileHash:     null,
      chatLog:      [],
      pendingAuxReq: null,
    });
    nameIndex.set(lc, code);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'master';

    socket.emit('room:created', { code, name: roomName, hasPassword: !!password, maxListeners: MAX_LISTENERS, isOwner: true });
    console.log(`[room] created "${roomName}" (${code})`);

    if (user?.id) {
      db.ensureRoom({ code, name: roomName, ownerId: user.id,
        passwordHash: password ? simpleHash(password.trim()) : null,
      }).catch(e => console.warn('[db] ensureRoom:', e.message));
    }
  });

  // ── room:check-name ───────────────────────────────────────────────────────
  socket.on('room:check-name', ({ name }) =>
    socket.emit('room:name-available', {
      available: !nameIndex.has((name || '').trim().toLowerCase()),
    })
  );

  // ── room:join ─────────────────────────────────────────────────────────────
  socket.on('room:join', async ({ code, name, password }) => {
    let c = (code || '').toUpperCase().trim();
    if (!rooms.has(c) && name) {
      const byName = nameIndex.get(name.trim().toLowerCase());
      if (byName) c = byName;
    }
    // Also resolve a plain room name typed into the join box against the DB
    if (!rooms.has(c) && !c.match(/^[A-Z]{3}-[0-9]{3}$/) && c.length >= 3) {
      const dbByName = await db.getPermanentRoom(c).catch(() => null);
      if (dbByName) c = dbByName.code;
    }

    let room = rooms.get(c);

    // ── Offline permanent room recovery ──────────────────────────────────────
    // Room exists in DB but server was restarted / room has no live host yet.
    // If the joining user is the DB owner, spin up a fresh in-memory room so
    // they become the host without needing to visit the Create screen.
    if (!room) {
      const joinUserId = user?.id;
      if (joinUserId && c.match(/^[A-Z]{3}-[0-9]{3}$/)) {
        const dbRoom = await db.getPermanentRoom(c).catch(() => null);
        if (dbRoom && dbRoom.owner_id === joinUserId) {
          // Recreate the in-memory room for this owner
          const lc = dbRoom.name.toLowerCase();
          if (!nameIndex.has(lc)) {   // only if name slot is free
            rooms.set(c, {
              code:         c,
              name:         dbRoom.name,
              masterSid:    socket.id,
              ownerSid:     socket.id,
              ownerName:    userName,
              ownerUserId:  joinUserId,
              followers:    new Map(),
              readySet:     new Set(),
              passwordHash: dbRoom.password_hash || null,
              hasPassword:  !!dbRoom.has_password,
              fileHash:     null,
              chatLog:      [],
              pendingAuxReq: null,
            });
            nameIndex.set(lc, c);
            room = rooms.get(c);

            // Join immediately as host
            socket.join(c);
            socket.data.code = c;
            socket.data.role = 'master';
            const chatHistory = await db.getChatHistory(c, 100).catch(() => []);
            socket.emit('room:rejoined', {
              code: c, name: dbRoom.name, role: 'master',
              listenerCount: 0, followerSids: [],
              hasFollower: false, fileHash: null, readyCount: 0,
              chatHistory, isOwner: true, currentHost: socket.id,
            });
            console.log('[room] permanent room restored from DB by owner:', c);
            return;
          }
        }
      }
      return socket.emit('room:err', { msg: 'Room not found. Check the code or name and try again.' });
    }

    if (room.passwordHash) {
      const attempt = password ? simpleHash(password.trim()) : '';
      if (attempt !== room.passwordHash)
        return socket.emit('room:err', { msg: 'Incorrect password.' });
    }

    const joinUserId  = user?.id;
    const isRoomOwner = joinUserId && room.ownerUserId && joinUserId === room.ownerUserId;
    const currentMasterGone = !room.masterSid ||
      !io.sockets.sockets.get(room.masterSid)?.connected;

    if (isRoomOwner) {
      clearTimeout(room._masterTimeout);

      if (room.masterSid && !currentMasterGone && room.masterSid !== socket.id) {
        // Another socket holds the host slot — join as listener but mark as owner
        room.followers.set(socket.id, { name: userName, displayName: userName });
        socket.join(c);
        socket.data.code = c;
        socket.data.role = 'follower';
        const chatHistory = await db.getChatHistory(c, 100).catch(() => room.chatLog || []);
        socket.emit('room:joined', {
          code: c, name: room.name, masterSid: room.masterSid,
          listenerCount: room.followers.size, maxListeners: MAX_LISTENERS,
          yourName: userName, chatHistory,
          isOwner: true, currentHost: room.masterSid,
        });
        io.to(room.masterSid).emit('peer:joined', { peerSid: socket.id, listenerCount: room.followers.size });
        io.to(c).emit('room:state', snapshot(room));
        console.log(`[room] owner joined as listener (host slot active): "${room.name}"`);
      } else {
        // Host slot free — promote owner to master
        if (room.followers.has(socket.id)) room.followers.delete(socket.id);
        room.masterSid = socket.id;
        room.ownerSid  = socket.id;
        socket.join(c);
        socket.data.code = c;
        socket.data.role = 'master';
        const chatHistory = await db.getChatHistory(c, 100).catch(() => room.chatLog || []);
        socket.emit('room:rejoined', {
          code: c, name: room.name, role: 'master',
          listenerCount: room.followers.size,
          followerSids:  [...room.followers.keys()],
          hasFollower:   room.followers.size > 0,
          fileHash:      room.fileHash || null,
          readyCount:    room.readySet.size,
          chatHistory,
          isOwner: true, currentHost: socket.id,
        });
        for (const [sid] of room.followers)
          io.to(sid).emit('peer:rejoined', { role: 'master', peerSid: socket.id });
        console.log(`[room] owner rejoined as host via room:join: "${room.name}"`);
      }
      if (joinUserId)
        db.ensureRoom({ code: c, name: room.name, ownerId: joinUserId }).catch(()=>{});
      return;
    }

    // Regular listener
    if (room.followers.size >= MAX_LISTENERS)
      return socket.emit('room:err', { msg: `Room is full — ${MAX_LISTENERS} listeners max.` });

    room.followers.set(socket.id, { name: userName, displayName: userName });
    socket.join(c);
    socket.data.code = c;
    socket.data.role = 'follower';

    if (joinUserId) {
      db.ensureRoom({ code: c, name: room.name, ownerId: null })
        .then(() => db.addRoomMember(c, joinUserId))
        .catch(e => console.warn('[db] join room member:', e.message));
    }

    const chatHistory = await db.getChatHistory(c, 100).catch(() => room.chatLog || []);
    socket.emit('room:joined', {
      code: c, name: room.name, masterSid: room.masterSid,
      listenerCount: room.followers.size, maxListeners: MAX_LISTENERS,
      yourName: userName, chatHistory,
      isOwner: false, currentHost: room.masterSid,
    });

    if (room.masterSid)
      io.to(room.masterSid).emit('peer:joined', { peerSid: socket.id, listenerCount: room.followers.size });
    io.to(c).emit('room:state', snapshot(room));
  });

  // ── room:info ─────────────────────────────────────────────────────────────
  socket.on('room:info', ({ code, name }) => {
    let c = (code || '').toUpperCase().trim();
    if (!rooms.has(c) && name) {
      const byName = nameIndex.get(name.trim().toLowerCase());
      if (byName) c = byName;
    }
    const room = rooms.get(c);
    if (!room) return socket.emit('room:info-res', { found: false });
    socket.emit('room:info-res', { found: true, ...snapshot(room) });
  });

  // ── room:leave ────────────────────────────────────────────────────────────
  socket.on('room:leave', () => {
    const { code, role } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (role === 'master') {
      clearTimeout(room._masterTimeout);
      const { deleteR2Object } = require('../routes/r2');
      if (room._r2Key) {
        clearTimeout(room._r2DeleteTimer);
        deleteR2Object(room._r2Key);
        room._r2Key = null;
      }
      nameIndex.delete(room.name.toLowerCase());
      rooms.delete(code);
      socket.to(code).emit('peer:left', { role: 'master', permanent: true });
      console.log(`[room] closed "${room.name}" by host`);
    } else {
      room.followers.delete(socket.id);
      room.readySet.delete(socket.id);
      if (room.masterSid)
        io.to(room.masterSid).emit('peer:left', {
          role: 'follower', peerSid: socket.id, permanent: true,
          listenerCount: room.followers.size,
        });
      io.to(code).emit('room:state', snapshot(room));
    }
    socket.data.code = null;
    socket.data.role = null;
    socket.leave(code);
  });

  // ── room:rejoin ───────────────────────────────────────────────────────────
  socket.on('room:rejoin', async ({ code, role }) => {
    const c    = (code || '').toUpperCase().trim();
    const room = rooms.get(c);

    if (!room)
      return socket.emit('room:rejoin-err', { msg: 'Room has expired. Please create or join a new room.' });

    if (role === 'master') {
      if (room.masterSid && room.masterSid !== socket.id) {
        const oldSocket = io.sockets.sockets.get(room.masterSid);
        if (oldSocket && oldSocket.connected)
          return socket.emit('room:rejoin-err', { msg: 'Host slot already taken.' });
        console.log('[room] clearing stale masterSid, accepting rejoin');
        room.masterSid = null;
      }
      clearTimeout(room._masterTimeout);
      room.masterSid = socket.id;
      socket.join(c);
      socket.data.code = c;
      socket.data.role = 'master';
      const chatHistory = await db.getChatHistory(c, 100).catch(() => room.chatLog || []);
      socket.emit('room:rejoined', {
        code: c, name: room.name, role: 'master',
        listenerCount: room.followers.size,
        followerSids:  [...room.followers.keys()],
        hasFollower:   room.followers.size > 0,
        fileHash:      room.fileHash || null,
        readyCount:    room.readySet.size,
        chatHistory,
        isOwner:       room.ownerSid === socket.id,
        currentHost:   room.masterSid,
      });
      for (const [sid] of room.followers)
        io.to(sid).emit('peer:rejoined', { role: 'master', peerSid: socket.id });
      console.log(`[room] host rejoined "${room.name}"`);

    } else {
      if (!room.followers.has(socket.id) && room.followers.size >= MAX_LISTENERS)
        return socket.emit('room:rejoin-err', { msg: 'Room is now full.' });
      room.followers.set(socket.id, { name: userName });
      socket.join(c);
      socket.data.code = c;
      socket.data.role = 'follower';
      const chatHistory = await db.getChatHistory(c, 100).catch(() => room.chatLog || []);
      socket.emit('room:rejoined', {
        code: c, name: room.name, role: 'follower',
        masterSid: room.masterSid, chatHistory,
        listenerCount: room.followers.size,
      });
      if (room.masterSid)
        io.to(room.masterSid).emit('peer:rejoined', {
          role: 'follower', peerSid: socket.id, listenerCount: room.followers.size,
        });
    }
  });
}

module.exports = { registerRoomHandlers, genCode, simpleHash, snapshot, MAX_LISTENERS };
