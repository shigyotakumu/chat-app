// ============================================================
// グローバル状態
// ============================================================
const socket = io();

let myUserId      = null;
let myUsername    = null;
let myAvatar      = null;
let mySocketId    = null;
let currentRoomId = null;
let currentDmId   = null;
let currentDmPartner = null;  // { id(socketId), username, avatar }
const unread      = {};
let onlineUsersList = [];
let cachedRooms   = [];

socket.on('connect', () => { mySocketId = socket.id; });

// ============================================================
// ユーティリティ
// ============================================================
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/** アバターHTML: url があれば img、なければ頭文字 */
function avatarHtml(name, url, size = '') {
  const initial = (name || '?').charAt(0).toUpperCase();
  const cls = `avatar${size ? ' ' + size : ''}`;
  if (url) return `<div class="${cls}"><img src="${escHtml(url)}" alt=""></div>`;
  return `<div class="${cls}">${escHtml(initial)}</div>`;
}

// ============================================================
// 通知 (Notification API)
// ============================================================
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showBrowserNotif(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(title, { body, icon: '/favicon.ico' });
    n.onclick = () => window.focus();
  }
}

// ============================================================
// トースト通知（アプリ内）
// ============================================================
function showToast(title, body, onClick) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-title">${escHtml(title)}</div><div class="toast-body">${escHtml(body)}</div>`;
  if (onClick) el.addEventListener('click', () => { onClick(); dismissToast(el); });
  container.appendChild(el);
  setTimeout(() => dismissToast(el), 4000);
}

function dismissToast(el) {
  el.classList.add('hiding');
  setTimeout(() => el.remove(), 200);
}

// ============================================================
// 認証（ログイン・登録）
// ============================================================
const authScreen  = document.getElementById('auth-screen');
const appEl       = document.getElementById('app');
const authError   = document.getElementById('auth-error');

function showAuthError(msg) { authError.textContent = msg; }

// タブ切り替え
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
    document.getElementById(tab.dataset.form).classList.remove('hidden');
    authError.textContent = '';
  });
});

// ログイン
document.getElementById('login-btn').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return showAuthError('入力してください');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(r => r.json());

  if (res.error) return showAuthError(res.error);
  enterApp(res.user);
});

// 登録
document.getElementById('register-btn').addEventListener('click', async () => {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;
  if (!username || !password) return showAuthError('入力してください');
  if (password !== confirm)   return showAuthError('パスワードが一致しません');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(r => r.json());

  if (res.error) return showAuthError(res.error);
  enterApp(res.user);
});

// Enter キー対応
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});
document.getElementById('reg-confirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('register-btn').click();
});

function enterApp(user) {
  myUserId   = user.id;
  myUsername = user.username;
  myAvatar   = user.avatar;

  authScreen.style.display = 'none';
  appEl.classList.add('visible');
  updateMyProfile();
  requestNotifPermission();

  // Socket.IO で認証
  socket.emit('authenticate', { userId: myUserId, username: myUsername }, (res) => {
    if (res?.error) console.error('Auth error:', res.error);
  });
}

// ============================================================
// プロフィールモーダル（アバター変更）
// ============================================================
const profileModal = document.getElementById('profile-modal');

document.getElementById('my-profile-btn').addEventListener('click', () => {
  document.getElementById('profile-avatar-preview').innerHTML = avatarHtml(myUsername, myAvatar, 'lg');
  profileModal.classList.add('open');
});
document.getElementById('profile-modal-close').addEventListener('click', () => {
  profileModal.classList.remove('open');
});
profileModal.addEventListener('click', e => {
  if (e.target === profileModal) profileModal.classList.remove('open');
});

document.getElementById('avatar-file-btn').addEventListener('click', () => {
  document.getElementById('avatar-file-input').click();
});

document.getElementById('avatar-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 1 * 1024 * 1024) {
    alert('画像は1MB以下にしてください');
    return;
  }

  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('userId', myUserId);

  const res = await fetch('/api/avatar', { method: 'POST', body: formData }).then(r => r.json());
  if (res.error) return alert(res.error);

  myAvatar = res.avatar;
  updateMyProfile();
  document.getElementById('profile-avatar-preview').innerHTML = avatarHtml(myUsername, myAvatar, 'lg');
  e.target.value = '';
});

function updateMyProfile() {
  document.getElementById('my-profile-avatar').innerHTML = avatarHtml(myUsername, myAvatar);
  document.getElementById('my-profile-name').textContent  = myUsername;
}

// アバター更新通知（自分の別タブ等から）
socket.on('avatar_updated', ({ avatar }) => {
  myAvatar = avatar;
  updateMyProfile();
});

// ============================================================
// チャンネル（ルーム）管理
// ============================================================
socket.on('room_list', rooms => renderRoomList(rooms));

function renderRoomList(rooms) {
  cachedRooms = rooms;
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(room => {
    const el  = document.createElement('div');
    const cnt = unread[room.id] || 0;
    el.className = 'room-item' + (room.id === currentRoomId ? ' active' : '');
    el.dataset.roomId = room.id;
    el.innerHTML = `
      <span class="room-name">${escHtml(room.name)}</span>
      ${cnt > 0
        ? `<span class="unread-badge">${cnt}</span>`
        : `<span class="room-count">${room.userCount}</span>`}
    `;
    el.addEventListener('click', () => joinRoom(room.id, room.name));
    list.appendChild(el);
  });
}

socket.on('room_activity', ({ roomId }) => {
  if (roomId === currentRoomId) return;
  unread[roomId] = (unread[roomId] || 0) + 1;
  renderRoomList(cachedRooms);
});

// ============================================================
// オンラインユーザー & DM
// ============================================================
socket.on('online_users', users => {
  onlineUsersList = users;
  renderDmList();
});

socket.on('dm_activity', ({ dmRoomId, fromUsername, fromSocketId }) => {
  if (dmRoomId === currentDmId) return;
  unread[dmRoomId] = (unread[dmRoomId] || 0) + 1;
  renderDmList();

  // トースト & ブラウザ通知
  showToast(`📩 ${fromUsername}`, 'ダイレクトメッセージが届きました', () => {
    openDm(fromSocketId, fromUsername);
  });
  showBrowserNotif(`📩 ${fromUsername}`, 'ダイレクトメッセージが届きました');
});

// DM 既読通知を受け取ったとき
socket.on('dm_read', ({ dmRoomId, readBy }) => {
  if (dmRoomId !== currentDmId) return;
  // 自分が送ったメッセージの最後のものに 既読 を表示
  updateReadReceipts(dmRoomId);
});

function renderDmList() {
  const list   = document.getElementById('dm-list');
  list.innerHTML = '';
  const others = onlineUsersList.filter(u => u.id !== mySocketId);
  others.forEach(u => {
    const dmRoomId = [mySocketId, u.id].sort().join('::');
    const isActive = currentDmId === dmRoomId;
    const cnt      = unread[dmRoomId] || 0;
    const el       = document.createElement('div');
    el.className = 'room-item dm-item' + (isActive ? ' active' : '');
    el.dataset.socketId = u.id;
    el.innerHTML = `
      <span class="dm-name">
        ${avatarHtml(u.username, u.avatar, 'sm online')}
        <span>${escHtml(u.username)}</span>
      </span>
      ${cnt > 0 ? `<span class="unread-badge">${cnt}</span>` : ''}
    `;
    el.addEventListener('click', () => openDm(u.id, u.username));
    list.appendChild(el);
  });
}

function openDm(targetSocketId, targetUsername) {
  socket.emit('open_dm', targetSocketId, (res) => {
    if (res.error) { console.error(res.error); return; }

    currentRoomId    = null;
    currentDmId      = res.dmRoomId;
    currentDmPartner = { id: targetSocketId, username: res.targetUsername || targetUsername, avatar: res.targetAvatar };
    delete unread[res.dmRoomId];

    document.getElementById('empty-state').style.display = 'none';
    const chatMain = document.getElementById('chat-main');
    chatMain.style.display = 'flex';

    document.getElementById('room-title').textContent = res.targetUsername || targetUsername;
    document.getElementById('chat-header').querySelector('.hash').innerHTML =
      avatarHtml(res.targetUsername || targetUsername, res.targetAvatar, 'sm online');
    document.getElementById('online-count').textContent = 'ダイレクトメッセージ';

    const msgs = document.getElementById('messages');
    msgs.innerHTML = '';
    res.history.forEach(m => appendMessage(m));
    scrollToBottom();

    document.querySelectorAll('.room-item').forEach(el => el.classList.remove('active'));
    renderDmList();
    document.getElementById('users-panel').style.display = 'none';

    // 読んだのでサーバーに通知
    socket.emit('mark_read', res.dmRoomId);
  });
}

// ============================================================
// チャンネル参加
// ============================================================
function joinRoom(id, name) {
  if (id === currentRoomId) return;
  socket.emit('join_room', id, (res) => {
    if (res.error) { console.error(res.error); return; }

    currentRoomId    = id;
    currentDmId      = null;
    currentDmPartner = null;
    delete unread[id];

    renderRoomList(cachedRooms);
    renderDmList();
    document.getElementById('users-panel').style.display = '';
    document.getElementById('chat-header').querySelector('.hash').textContent = '#';

    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('chat-main').style.display   = 'flex';

    document.getElementById('room-title').textContent = name;
    updateUsers(res.users);

    const msgs = document.getElementById('messages');
    msgs.innerHTML = '';
    res.history.forEach(m => appendMessage(m));
    scrollToBottom();

    document.querySelectorAll('.room-item').forEach(el => {
      el.classList.toggle('active', el.dataset.roomId === id);
    });
  });
}

// ============================================================
// メッセージ表示
// ============================================================
function appendMessage(msg) {
  const msgs = document.getElementById('messages');
  const el   = document.createElement('div');
  el.className = 'msg';
  el.dataset.msgId = msg.id;

  // DM の場合、自分が送ったか判定（sender_id または username で判定）
  const isMine = (msg.sender_id != null)
    ? msg.sender_id === myUserId
    : msg.username  === myUsername;

  // 既読表示（DM & 自分のメッセージ & 既読）
  const isReadHtml = (currentDmId && isMine && msg.is_read)
    ? `<div class="msg-read">✓ 既読</div>` : '';

  const imageHtml = msg.image
    ? `<img class="msg-image" src="${msg.image}" alt="画像" loading="lazy">` : '';
  const textHtml  = msg.text
    ? `<div class="msg-text">${escHtml(msg.text)}</div>` : '';

  el.innerHTML = `
    ${avatarHtml(msg.username, msg.avatar, 'sm')}
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-user">${escHtml(msg.username)}</span>
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      </div>
      ${textHtml}${imageHtml}
      ${isReadHtml}
    </div>
  `;

  if (msg.image) {
    el.querySelector('.msg-image').addEventListener('click', () => openLightbox(msg.image));
  }
  msgs.appendChild(el);
}

function appendSystem(text) {
  const msgs = document.getElementById('messages');
  const el   = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  msgs.appendChild(el);
}

const scrollToBottom = () => {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
};

const isNearBottom = () => {
  const msgs = document.getElementById('messages');
  return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
};

// 既読バッジを更新（DM の自分のメッセージを走査して最後のものに既読を付ける）
function updateReadReceipts(dmRoomId) {
  if (dmRoomId !== currentDmId) return;
  const msgs = document.getElementById('messages');
  // まず全メッセージから既読表示を削除
  msgs.querySelectorAll('.msg-read').forEach(el => el.remove());

  // 自分が送ったメッセージの最後の1件に 既読 を付ける
  const myMsgs = [...msgs.querySelectorAll('.msg')].filter(el => {
    const userEl = el.querySelector('.msg-user');
    return userEl && userEl.textContent === myUsername;
  });
  if (myMsgs.length > 0) {
    const last = myMsgs[myMsgs.length - 1];
    const body = last.querySelector('.msg-body');
    if (body) {
      const readEl = document.createElement('div');
      readEl.className = 'msg-read';
      readEl.innerHTML = '✓ 既読';
      body.appendChild(readEl);
    }
  }
}

socket.on('new_message', (msg) => {
  appendMessage(msg);
  if (msg.username === myUsername || isNearBottom()) scrollToBottom();

  // 今開いているDMで受け取ったら既読にする
  if (currentDmId && (msg.dm_room_id === currentDmId) && msg.username !== myUsername) {
    socket.emit('mark_read', currentDmId);
  }

  // チャンネルのメッセージで今開いていないルームなら通知
  if (msg.room_id && msg.room_id !== currentRoomId && msg.username !== myUsername) {
    showToast(`#${msg.room_id} ${msg.username}`, msg.text || '画像', () => joinRoom(msg.room_id, msg.room_id));
    showBrowserNotif(`${msg.username} (#${msg.room_id})`, msg.text || '画像が届きました');
  }

  // DM で相手のメッセージが来たとき（フォーカスなし）
  if (msg.dm_room_id && msg.username !== myUsername && document.hidden) {
    showBrowserNotif(`📩 ${msg.username}`, msg.text || '画像が届きました');
  }
});

socket.on('user_joined', ({ username, users }) => {
  appendSystem(`${username} が参加しました`);
  updateUsers(users);
  scrollToBottom();
});

socket.on('user_left', ({ username, users }) => {
  if (username) appendSystem(`${username} が退出しました`);
  updateUsers(users);
  scrollToBottom();
});

// ============================================================
// ユーザー一覧
// ============================================================
function updateUsers(users) {
  const list  = document.getElementById('user-list');
  const count = document.getElementById('online-count');
  list.innerHTML = '';
  // users は { username, avatar }[] または string[]（後方互換）
  const arr = Array.isArray(users) ? users : [];
  count.textContent = `${arr.length}人オンライン`;
  arr.forEach(u => {
    const el = document.createElement('div');
    el.className = 'user-item';
    const name = typeof u === 'string' ? u : u.username;
    const av   = typeof u === 'object' ? u.avatar : null;
    el.innerHTML = `${avatarHtml(name, av, 'sm online')} <span>${escHtml(name)}</span>`;
    list.appendChild(el);
  });
}

// ============================================================
// 画像添付
// ============================================================
let pendingImage = null;

function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 2 * 1024 * 1024) { alert('画像は2MB以下にしてください'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingImage = e.target.result;
    document.getElementById('image-preview-thumb').src = pendingImage;
    document.getElementById('image-preview-area').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

document.getElementById('image-btn').addEventListener('click', () => {
  document.getElementById('image-file-input').click();
});
document.getElementById('image-file-input').addEventListener('change', e => {
  loadImageFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('image-cancel-btn').addEventListener('click', () => {
  pendingImage = null;
  document.getElementById('image-preview-area').style.display = 'none';
  document.getElementById('image-preview-thumb').src = '';
});
document.addEventListener('paste', e => {
  if (!currentRoomId && !currentDmId) return;
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile());
});

// ライトボックス
const lightbox = document.getElementById('lightbox');
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  lightbox.classList.add('open');
}

// ============================================================
// タイピングインジケーター
// ============================================================
const typingUsers = new Map();

function renderTyping() {
  const el    = document.getElementById('typing-indicator');
  const names = [...typingUsers.keys()];
  if (names.length === 0) { el.innerHTML = ''; return; }
  const text = names.length === 1
    ? `${escHtml(names[0])} が入力中`
    : `${names.map(escHtml).join('、')} が入力中`;
  el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>${text}`;
}

socket.on('typing', ({ username: u, isTyping }) => {
  if (typingUsers.has(u)) clearTimeout(typingUsers.get(u));
  if (isTyping) {
    const tid = setTimeout(() => { typingUsers.delete(u); renderTyping(); }, 3000);
    typingUsers.set(u, tid);
  } else {
    typingUsers.delete(u);
  }
  renderTyping();
});

// ============================================================
// メッセージ送信
// ============================================================
const msgInput = document.getElementById('msg-input');
const sendBtn  = document.getElementById('send-btn');
let typingTimeout = null;
let isTypingFlag  = false;

function sendMessage() {
  const text   = msgInput.value;
  const roomId = currentDmId || currentRoomId;
  if (!text.trim() && !pendingImage) return;
  if (!roomId) return;

  socket.emit('send_message', { text, image: pendingImage, roomId }, res => {
    if (res?.error) alert(res.error);
  });

  if (isTypingFlag) {
    isTypingFlag = false;
    socket.emit('typing', currentDmId ? { isTyping: false, dmRoomId: currentDmId } : false);
  }
  clearTimeout(typingTimeout);

  msgInput.value = '';
  msgInput.style.height = 'auto';
  if (pendingImage) {
    pendingImage = null;
    document.getElementById('image-preview-area').style.display = 'none';
    document.getElementById('image-preview-thumb').src = '';
  }
  msgInput.focus();
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

msgInput.addEventListener('input', () => {
  autoResize(msgInput);
  const roomId = currentDmId || currentRoomId;
  if (!roomId) return;

  const typingOn  = currentDmId ? { isTyping: true,  dmRoomId: currentDmId } : true;
  const typingOff = currentDmId ? { isTyping: false, dmRoomId: currentDmId } : false;

  if (!isTypingFlag) { isTypingFlag = true; socket.emit('typing', typingOn); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { isTypingFlag = false; socket.emit('typing', typingOff); }, 2000);
});

// ============================================================
// ページがフォーカスされたとき既読にする
// ============================================================
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentDmId) {
    socket.emit('mark_read', currentDmId);
  }
});

// ============================================================
// モバイル: サイドバードロワー開閉
// ============================================================
const sidebarEl      = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebarToggle  = document.getElementById('sidebar-toggle');

function openSidebar() {
  sidebarEl.classList.add('open');
  sidebarOverlay.classList.add('open');
}

function closeSidebar() {
  sidebarEl.classList.remove('open');
  sidebarOverlay.classList.remove('open');
}

// ハンバーガーボタンでトグル
sidebarToggle.addEventListener('click', () => {
  sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar();
});

// オーバーレイクリックで閉じる
sidebarOverlay.addEventListener('click', closeSidebar);

// チャンネルまたはDMを選んだらサイドバーを閉じる（モバイルのみ）
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) closeSidebar();
}

// チャンネル・DM選択時にサイドバーを自動で閉じる（モバイルのみ）
// room-list / dm-list の click イベントをキャプチャ
document.getElementById('room-list').addEventListener('click', closeSidebarOnMobile);
document.getElementById('dm-list').addEventListener('click', closeSidebarOnMobile);

// ============================================================
// モバイル: キーボード表示時の画面ズレ対策
// Visual Viewport API でキーボード高さを取得してlayoutを調整
// ============================================================
if (window.visualViewport) {
  let prevHeight = window.visualViewport.height;

  window.visualViewport.addEventListener('resize', () => {
    const currentHeight = window.visualViewport.height;
    const app = document.getElementById('app');

    // キーボードが開いた / 閉じた
    app.style.height = currentHeight + 'px';

    // キーボードが開いたとき(高さが縮んだとき)メッセージを一番下に
    if (currentHeight < prevHeight) {
      setTimeout(scrollToBottom, 50);
    }
    prevHeight = currentHeight;
  });
}
