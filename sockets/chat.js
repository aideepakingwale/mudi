/**
 * sockets/chat.js — Room chat, voice messages, emoji reactions
 *
 * Events: chat:send, chat:voice, reaction:send
 * Scoring:
 *   chat message  — 1pt per word + 5pt reply bonus
 *   reaction      — 10pts
 *   voice message — 5pts
 */
'use strict';

const db = require('../db');

function registerChatHandlers(socket, io, rooms) {
  const user = socket.request?.user;

  // ── Voice message ─────────────────────────────────────────────────────────
  socket.on('chat:voice', async ({ data, duration, systemAudio, replyToId, replyText, replySender }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || !data) return;

    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName || follower?.name || (user?.name || 'Guest');
    const role       = room.masterSid === socket.id ? 'master' : 'follower';

    const payload = {
      sid: socket.id, senderName, role, ts: Date.now(),
      voiceData: data, duration, systemAudio: !!systemAudio,
      replyToId: replyToId||null, replyText: replyText||null, replySender: replySender||null,
      text: systemAudio ? '[System audio]' : '[Voice message]',
    };
    io.to(code).emit('chat:message', payload);

    const logEntry = { ...payload, voiceData: undefined };
    room.chatLog.push(logEntry);
    if (room.chatLog.length > 100) room.chatLog.shift();
    db.saveChat(code, { sid: socket.id, senderName, role, text: logEntry.text }).catch(()=>{});

    if (user?.id) {
      db.addPoints(user.id, 'voice', 5).catch(()=>{});
      const board = await db.getLeaderboard(code).catch(()=>[]);
      io.to(code).emit('leaderboard:data', { board });
    }
  });

  // ── Text message ──────────────────────────────────────────────────────────
  socket.on('chat:send', async ({ text, replyToId: rToId, replyText: rText, replySender: rSender }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || !text) return;

    const msg  = (text || '').trim().slice(0, 280);
    if (!msg) return;

    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName
      || (room.masterSid === socket.id ? (user?.name || 'Host') : (user?.name || 'Listener'));
    const role       = room.masterSid === socket.id ? 'master' : 'follower';
    const replyToId  = typeof rToId === 'number' ? rToId : null;
    const replyText  = rText   || null;
    const replySender = rSender || null;

    const payload = {
      sid: socket.id, senderName, role, text: msg, ts: Date.now(),
      replyToId, replyText, replySender,
    };
    io.to(code).emit('chat:message', payload);

    room.chatLog.push(payload);
    if (room.chatLog.length > 100) room.chatLog.shift();

    db.saveChat(room.code, { sid: socket.id, senderName, role, text: msg, replyToId, replyText, replySender })
      .then(id => { payload.id = id; })
      .catch(e => console.warn('[chat] DB save failed:', e.message));

    if (user?.id) {
      const wordCount  = msg.trim().split(/\s+/).filter(Boolean).length;
      const replyBonus = replyToId ? 5 : 0;
      if (wordCount)  db.addPoints(user.id, 'word', wordCount).catch(()=>{});
      if (replyBonus) db.addPoints(user.id, 'reply', replyBonus).catch(()=>{});
      db.incrementCounter(user.id, 'messages_sent').catch(()=>{});
      const board = await db.getLeaderboard(code).catch(()=>[]);
      io.to(code).emit('leaderboard:data', { board });
    }
  });

  // ── Emoji reaction ────────────────────────────────────────────────────────
  socket.on('reaction:send', async ({ emoji }) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;

    // Validate: only allow emoji-like strings (up to 8 chars)
    if (!emoji || emoji.length > 8) return;

    const follower   = room.followers.get(socket.id);
    const senderName = follower?.displayName || follower?.name || (user?.name || 'Someone');

    io.to(code).emit('reaction:broadcast', { emoji, senderName, sid: socket.id, ts: Date.now() });

    // Log in chat history
    const rxnMsg = {
      sid: socket.id, senderName, role: socket.data.role || 'follower',
      text: senderName + ' reacted ' + emoji, ts: Date.now(),
      isReaction: true, emoji,
    };
    room.chatLog.push(rxnMsg);
    if (room.chatLog.length > 100) room.chatLog.shift();
    db.saveChat(code, { sid: socket.id, senderName, role: rxnMsg.role, text: rxnMsg.text }).catch(()=>{});

    if (user?.id) {
      db.addPoints(user.id, 'reaction', 10).catch(()=>{});
      db.incrementCounter(user.id, 'reactions_sent').catch(()=>{});
      db.addReactionLog(code, user.id, senderName, emoji).catch(()=>{});
      const board = await db.getLeaderboard(code).catch(()=>[]);
      io.to(code).emit('leaderboard:data', { board });
    }
  });
}

module.exports = { registerChatHandlers };
