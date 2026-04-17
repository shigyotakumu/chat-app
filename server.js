const express  = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const bcrypt    = require('bcrypt');
const Database  = require('better-sqlite3');
const multer    = require('multer');
const fs        = require('fs');

// ── サーバー初期化 ──────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SQLite DB ──────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar       TEXT DEFAULT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id   TEXT NOT NULL,
    user_id   INTEGER NOT NULL,
    username  TEXT NOT NULL,
    avatar    TEXT,
    text      TEXT,
    image     TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_room_id TEXT NOT NULL,
    sender_id  INTEGER NOT NULL,
    username   TEXT NOT NULL,
    avatar     TEXT,
    text       TEXT,
    image      TEXT,
    timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read    INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dm_read (
    user_id    INTEGER NOT NULL,
    dm_room_id TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, dm_room_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room   ON messages(room_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_dm_messages_room ON dm_messages(dm_room_id, timestamp);
`);

// ── アバターアップロード ────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

// ── チャンネル定義 ─────────────────────────────────────────────
const ROOMS = {
  general: { name: 'ゼネラル' },
  random:  { name: 'ランダム' },
  tech:    { name: 'テック'    },
};
const roomUsers = { general: new Map(), random: new Map(), tech: new Map() };

// socketId → { id(socket), userId, username, avatar }
const globalUsers = new Map();

const MAX_HISTORY = 100;

// ── ヘルパー ───────────────────────────────────────────────────
const getRoomList = () =>
  Object.entries(ROOMS).map(([id, r]) => ({
    id, name: r.name, userCount: roomUsers[id]?.size ?? 0,
  }));

const getOnlineUsers = () => [...globalUsers.values()];

// ── REST API ───────────────────────────────────────────────────

// 新規登録
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.json({ error: 'ユーザー名とパスワードを入力してください' });
  if (username.trim().length > 20)    return res.json({ error: 'ユーザー名は20文字以内' });
  if (password.length < 4)            return res.json({ error: 'パスワードは4文字以上' });
  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username.trim(), hash);
    const user   = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ok: true, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.json({ error: 'そのユーザー名は使われています' });
    res.json({ error: 'エラーが発生しました' });
  }
});

// ログイン
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.json({ error: 'ユーザー名とパスワードを入力してください' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.json({ error: 'ユーザー名またはパスワードが違います' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.json({ error: 'ユーザー名またはパスワードが違います' });
  res.json({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

// アバターアップロード
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const userId = parseInt(req.body.userId, 10);
  if (!userId || !req.file) return res.json({ error: 'アップロード失敗' });

  // 古いアバターファイルを削除
  const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(userId);
  if (old?.avatar) {
    const oldPath = path.join(__dirname, 'public', old.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const avatarUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, userId);

  // 接続中の同ユーザーのソケットにアバター変更を通知
  for (const [sid, u] of globalUsers) {
    if (u.userId === userId) {
      u.avatar = avatarUrl;
      io.sockets.sockets.get(sid)?.emit('avatar_updated', { avatar: avatarUrl });
    }
  }
  io.emit('online_users', getOnlineUsers());
  res.json({ ok: true, avatar: avatarUrl });
});

// ── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let userId      = null;
  let username    = null;
  let userAvatar  = null;

  socket.emit('room_list', getRoomList());

  // 認証（ログイン後に呼ぶ）
  socket.on('authenticate', (data, cb) => {
    const user = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(data.userId);
    if (!user || user.username !== data.username) return cb?.({ error: '認証エラー' });

    userId     = user.id;
    username   = user.username;
    userAvatar = user.avatar;

    globalUsers.set(socket.id, { id: socket.id, userId, username, avatar: userAvatar });
    io.emit('online_users', getOnlineUsers());
    cb?.({ ok: true });
  });

  // チャンネル参加
  socket.on('join_room', (roomId, cb) => {
    if (!ROOMS[roomId]) return cb?.({ error: 'Room not found' });
    if (!username)      return cb?.({ error: 'Authenticate first' });

    if (currentRoom && roomUsers[currentRoom]) {
      socket.leave(currentRoom);
      roomUsers[currentRoom].delete(socket.id);
      io.to(currentRoom).emit('user_left', {
        username,
        users: [...roomUsers[currentRoom].values()].map(u => ({ username: u.username, avatar: u.avatar })),
      });
    }

    currentRoom = roomId;
    socket.join(roomId);
    roomUsers[roomId].set(socket.id, { username, avatar: userAvatar });

    const users   = [...roomUsers[roomId].values()];
    const history = db.prepare(
      'SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(roomId, MAX_HISTORY).reverse();

    socket.to(roomId).emit('user_joined', { username, users: users.map(u => ({ username: u.username, avatar: u.avatar })) });
    cb?.({ ok: true, history, users: users.map(u => ({ username: u.username, avatar: u.avatar })) });
    io.emit('room_list', getRoomList());
  });

  // DM を開く
  socket.on('open_dm', (targetSocketId, cb) => {
    if (!username) return cb?.({ error: 'Authenticate first' });
    if (socket.id === targetSocketId) return cb?.({ error: 'Cannot DM yourself' });
    const targetUser = globalUsers.get(targetSocketId);
    if (!targetUser) return cb?.({ error: 'User not found' });

    const dmRoomId = [socket.id, targetSocketId].sort().join('::');
    socket.join(dmRoomId);
    io.sockets.sockets.get(targetSocketId)?.join(dmRoomId);

    const history = db.prepare(
      'SELECT * FROM dm_messages WHERE dm_room_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(dmRoomId, MAX_HISTORY).reverse();

    // 自分宛の未読を既読に
    db.prepare('UPDATE dm_messages SET is_read=1 WHERE dm_room_id=? AND sender_id!=?').run(dmRoomId, userId);
    db.prepare('INSERT OR REPLACE INTO dm_read (user_id, dm_room_id, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(userId, dmRoomId);

    // 相手に既読通知
    io.sockets.sockets.get(targetSocketId)?.emit('dm_read', { dmRoomId, readBy: username });

    cb?.({ ok: true, dmRoomId, targetUsername: targetUser.username, targetAvatar: targetUser.avatar, history });
  });

  // タイピング
  socket.on('typing', (payload) => {
    const isTyping  = typeof payload === 'boolean' ? payload : payload.isTyping;
    const dmRoomId  = typeof payload === 'object'  ? payload.dmRoomId : null;
    if (dmRoomId) {
      socket.to(dmRoomId).emit('typing', { username, isTyping });
    } else {
      if (!currentRoom || !username) return;
      socket.to(currentRoom).emit('typing', { username, isTyping });
    }
  });

  // メッセージ送信
  socket.on('send_message', (payload, cb) => {
    if (!username || !userId) return;

    const text    = typeof payload === 'string' ? payload : (payload.text ?? '');
    const image   = typeof payload === 'object' ? (payload.image ?? null) : null;
    const roomId  = typeof payload === 'object' ? (payload.roomId ?? currentRoom) : currentRoom;
    if (!roomId) return;

    const trimmed = text.trim().slice(0, 1000);
    if (!trimmed && !image) return;
    if (image && image.length > 2.8 * 1024 * 1024) return cb?.({ error: '画像は2MB以下' });

    const timestamp = new Date().toISOString();

    if (ROOMS[roomId]) {
      if (roomId !== currentRoom) return;
      const result = db.prepare(
        'INSERT INTO messages (room_id,user_id,username,avatar,text,image,timestamp) VALUES (?,?,?,?,?,?,?)'
      ).run(roomId, userId, username, userAvatar, trimmed || null, image || null, timestamp);

      const msg = { id: result.lastInsertRowid, room_id: roomId, user_id: userId, username, avatar: userAvatar, text: trimmed, image: image ?? null, timestamp };
      io.to(roomId).emit('new_message', msg);
      socket.broadcast.emit('room_activity', { roomId });

    } else {
      const parts = roomId.split('::');
      if (!parts.includes(socket.id)) return cb?.({ error: 'Unauthorized' });

      const result = db.prepare(
        'INSERT INTO dm_messages (dm_room_id,sender_id,username,avatar,text,image,timestamp,is_read) VALUES (?,?,?,?,?,?,?,0)'
      ).run(roomId, userId, username, userAvatar, trimmed || null, image || null, timestamp);

      const msg = { id: result.lastInsertRowid, dm_room_id: roomId, sender_id: userId, username, avatar: userAvatar, text: trimmed, image: image ?? null, timestamp, is_read: 0 };
      io.to(roomId).emit('new_message', msg);

      // 相手の未読通知
      const otherSocketId = parts.find(id => id !== socket.id);
      if (otherSocketId) {
        io.sockets.sockets.get(otherSocketId)?.emit('dm_activity', {
          dmRoomId: roomId, fromUsername: username, fromSocketId: socket.id,
        });
      }
    }
    cb?.({ ok: true });
  });

  // DM 既読マーク
  socket.on('mark_read', (dmRoomId) => {
    if (!userId) return;
    db.prepare('UPDATE dm_messages SET is_read=1 WHERE dm_room_id=? AND sender_id!=?').run(dmRoomId, userId);
    db.prepare('INSERT OR REPLACE INTO dm_read (user_id,dm_room_id,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(userId, dmRoomId);

    const parts = dmRoomId.split('::');
    const otherSocketId = parts.find(id => id !== socket.id);
    if (otherSocketId) {
      io.sockets.sockets.get(otherSocketId)?.emit('dm_read', { dmRoomId, readBy: username });
    }
  });

  // 切断
  socket.on('disconnect', () => {
    globalUsers.delete(socket.id);
    io.emit('online_users', getOnlineUsers());
    if (currentRoom && roomUsers[currentRoom]) {
      roomUsers[currentRoom].delete(socket.id);
      io.to(currentRoom).emit('user_left', {
        username,
        users: [...roomUsers[currentRoom].values()].map(u => ({ username: u.username, avatar: u.avatar })),
      });
      io.emit('room_list', getRoomList());
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat server: http://localhost:${PORT}`));
