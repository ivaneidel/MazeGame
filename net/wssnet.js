/**
 * ============================================================
 *  WSSNet — Lightweight WebSocket Multiplayer Client
 * ============================================================
 *
 *  A drop-in module for building real-time 2-player browser
 *  games over a simple WebSocket relay server.
 *
 *  FEATURES
 *  ─────────────────────────────────────────────────────────
 *  • Connects to a WSS relay server (with URL persistence)
 *  • 4-digit room code pairing between two players
 *  • Automatic reconnection with session-based ID resumption
 *  • Ghost state: pairs survive short disconnects (30s)
 *  • Self-contained modal UIs for server setup and pairing
 *  • Themeable via CSS custom properties
 *  • Zero dependencies — single JS file
 *
 *  QUICK START
 *  ─────────────────────────────────────────────────────────
 *  <script src="https://ivaneidel.github.io/html-games/net/wssnet.js"></script>
 *  <script>
 *    const net = new WSSNet({
 *      onReady(myId)        { console.log('My ID:', myId); },
 *      onPaired(myId, peer) { startGame(myId, peer); },
 *      onMessage(data)      { handleGameMessage(data); },
 *      onReconnected(peer)  { resync(); },
 *      onPeerDisconnected() { showWaitingBanner(); },
 *    });
 *
 *    net.mountServerModal();  // Step 1: ask for server URL
 *    // mountPairModal() is typically called inside onReady()
 *  </script>
 *
 *  API REFERENCE
 *  ─────────────────────────────────────────────────────────
 *
 *  Constructor:
 *    new WSSNet(callbacks)
 *      callbacks.onReady(myId)          — Server connected, ID assigned
 *      callbacks.onPaired(myId, peer)   — Paired with an opponent
 *      callbacks.onReconnected(peer)    — Reconnected after a drop
 *      callbacks.onPeerDisconnected()   — Opponent dropped (may rejoin)
 *      callbacks.onMessage(data)        — Received a message from peer
 *                                         data is the original object passed to send()
 *
 *  Methods:
 *    net.mountServerModal(container?)
 *      Injects the server URL prompt into the DOM.
 *      Auto-hides on successful connection. Fires onReady().
 *      container defaults to document.body.
 *
 *    net.mountPairModal(container?)
 *      Injects the room code UI into the DOM.
 *      Shows your ID and an input to enter a peer's ID.
 *      Auto-hides on successful pairing. Fires onPaired().
 *
 *    net.send(data)
 *      Send any JSON-serializable object to your paired peer.
 *      data is received as-is in the peer's onMessage(data).
 *
 *    net.myId  — Your current session ID (string)
 *    net.peer  — Paired peer's ID (string, null if not paired)
 *
 *  THEMING
 *  ─────────────────────────────────────────────────────────
 *  Override these CSS variables on :root or any ancestor:
 *
 *    --wssnet-accent:      #4caf50    Button + highlight color
 *    --wssnet-bg:          #000c      Modal overlay background
 *    --wssnet-card-bg:     #111       Modal card background
 *    --wssnet-font:        monospace  Font family
 *    --wssnet-radius:      12px       Border radius
 *    --wssnet-error:       #ff6b6b    Error text color
 *
 *  PROTOCOL (for compatible server implementations)
 *  ─────────────────────────────────────────────────────────
 *  Client → Server:
 *    { type: "rejoin",  id: "1234" }             Resume a session
 *    { type: "connect", target: "5678" }         Pair with a peer
 *    { type: "message", text: "<json string>" }  Relay a message
 *
 *  Server → Client:
 *    { type: "id",               id }            Session assigned
 *    { type: "connected",        with }          Pairing confirmed
 *    { type: "reconnected",      with }          Session resumed
 *    { type: "peer_disconnected"            }    Peer dropped
 *    { type: "message",          text }          Relayed message
 *    { type: "error",            message }       Server error
 *
 * ============================================================
 */

class WSSNet {
  constructor(callbacks = {}) {
    this._cb = {
      onReady:           callbacks.onReady           || (() => {}),
      onPaired:          callbacks.onPaired          || (() => {}),
      onReconnected:     callbacks.onReconnected     || (() => {}),
      onPeerDisconnected:callbacks.onPeerDisconnected|| (() => {}),
      onMessage:         callbacks.onMessage         || (() => {}),
    };

    this.myId = null;
    this.peer = null;

    this._ws = null;
    this._url = null;
    this._reconnectTimer = null;
    this._serverModalEl = null;
    this._pairModalEl = null;

    this._injectStyles();
  }

  // ── PUBLIC: SEND ───────────────────────────────────────────
  send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        type: 'message',
        text: JSON.stringify(data)
      }));
    }
  }

  // ── PUBLIC: MOUNT SERVER MODAL ─────────────────────────────
  mountServerModal(container = document.body) {
    const el = document.createElement('div');
    el.className = 'wssnet-overlay';
    el.innerHTML = `
      <div class="wssnet-card">
        <div class="wssnet-title">🌐 SERVER</div>
        <div class="wssnet-hint">Enter your server URL — domain only or full URL</div>
        <input class="wssnet-input" id="wssnet-server-input"
          placeholder="your-tunnel.trycloudflare.com"
          autocapitalize="none" autocorrect="off" spellcheck="false">
        <div class="wssnet-error" id="wssnet-server-error"></div>
        <button class="wssnet-btn" id="wssnet-server-btn">Connect</button>
      </div>
    `;
    container.appendChild(el);
    this._serverModalEl = el;

    // Pre-fill saved URL
    const saved = this._savedUrl();
    if (saved) {
      el.querySelector('#wssnet-server-input').value = saved.replace(/^wss:\/\//, '');
    }

    const submit = () => this._submitServer();
    el.querySelector('#wssnet-server-btn').addEventListener('click', submit);
    el.querySelector('#wssnet-server-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
    });

    // Auto-connect if we have a saved URL
    if (saved) {
      this._setServerError('Connecting…');
      this._tryConnect(saved, ok => {
        if (ok) {
          this._url = saved;
          this._hideServerModal();
          this._connect();
        } else {
          this._setServerError('✗ Saved server unreachable. Enter a new URL.');
        }
      });
    }
  }

  // ── PUBLIC: MOUNT PAIR MODAL ───────────────────────────────
  mountPairModal(container = document.body) {
    const el = document.createElement('div');
    el.className = 'wssnet-overlay';
    el.innerHTML = `
      <div class="wssnet-card">
        <div class="wssnet-title">🎲 CONNECT</div>
        <div class="wssnet-hint">Your room code</div>
        <div class="wssnet-code" id="wssnet-my-id">…</div>
        <div class="wssnet-hint" style="margin-top:14px">Enter opponent's code</div>
        <input class="wssnet-input wssnet-input-center" id="wssnet-peer-input"
          placeholder="0000" maxlength="8"
          autocapitalize="none" autocorrect="off">
        <button class="wssnet-btn" id="wssnet-pair-btn">Pair</button>
      </div>
    `;
    container.appendChild(el);
    this._pairModalEl = el;

    // Show myId if already known
    if (this.myId) el.querySelector('#wssnet-my-id').innerText = this.myId;

    const submit = () => this._submitPair();
    el.querySelector('#wssnet-pair-btn').addEventListener('click', submit);
    el.querySelector('#wssnet-peer-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
    });
  }

  // ── PRIVATE: SERVER SUBMIT ─────────────────────────────────
  _submitServer() {
    const input = document.getElementById('wssnet-server-input');
    if (!input || !input.value.trim()) return;
    const url = this._normalizeUrl(input.value);
    this._setServerError('Connecting…');
    this._tryConnect(url, ok => {
      if (ok) {
        this._url = url;
        this._saveUrl(url);
        // Reload so state is clean with new URL
        location.reload();
      } else {
        this._setServerError('✗ Could not connect. Check the URL.');
      }
    });
  }

  _setServerError(msg) {
    const el = document.getElementById('wssnet-server-error');
    if (el) el.textContent = msg;
  }

  _hideServerModal() {
    if (this._serverModalEl) this._serverModalEl.style.display = 'none';
  }

  _hidePairModal() {
    if (this._pairModalEl) this._pairModalEl.style.display = 'none';
  }

  // ── PRIVATE: PAIR SUBMIT ───────────────────────────────────
  _submitPair() {
    const input = document.getElementById('wssnet-peer-input');
    if (!input || !input.value.trim()) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'connect', target: input.value.trim() }));
    }
  }

  // ── PRIVATE: WS CONNECTION ─────────────────────────────────
  _connect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._ws = new WebSocket(this._url);

    this._ws.onopen = () => {
      const oldId = this._savedId();
      if (oldId) this._ws.send(JSON.stringify({ type: 'rejoin', id: oldId }));
    };

    this._ws.onmessage = e => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'id') {
        this.myId = msg.id;
        this._saveId(msg.id);
        // Update pair modal if mounted
        const codeEl = document.getElementById('wssnet-my-id');
        if (codeEl) codeEl.innerText = msg.id;
        this._cb.onReady(msg.id);
      }

      if (msg.type === 'connected') {
        this.peer = msg.with;
        this._hidePairModal();
        this._cb.onPaired(this.myId, msg.with);
      }

      if (msg.type === 'reconnected') {
        this.peer = msg.with;
        this._hidePairModal();
        this._cb.onReconnected(msg.with);
      }

      if (msg.type === 'peer_disconnected') {
        this._cb.onPeerDisconnected();
      }

      if (msg.type === 'message') {
        try {
          const data = JSON.parse(msg.text);
          this._cb.onMessage(data);
        } catch (_) {}
      }
    };

    this._ws.onclose = () => {
      this._reconnectTimer = setTimeout(() => this._connect(), 3000);
    };

    this._ws.onerror = () => this._ws.close();
  }

  // ── PRIVATE: PROBE ─────────────────────────────────────────
  _tryConnect(url, cb) {
    const probe = new WebSocket(url);
    const t = setTimeout(() => { probe.close(); cb(false); }, 5000);
    probe.onopen  = () => { clearTimeout(t); probe.close(); cb(true); };
    probe.onerror = () => { clearTimeout(t); cb(false); };
  }

  // ── PRIVATE: PERSISTENCE ───────────────────────────────────
  _savedUrl()     { return localStorage.getItem('wssnet_url'); }
  _saveUrl(url)   { localStorage.setItem('wssnet_url', url); }
  _savedId()      { return sessionStorage.getItem('wssnet_id'); }
  _saveId(id)     { sessionStorage.setItem('wssnet_id', id); }

  _normalizeUrl(raw) {
    return 'wss://' + raw.trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^wss?:\/\//i, '')
      .replace(/\/$/, '');
  }

  // ── PRIVATE: STYLES ────────────────────────────────────────
  _injectStyles() {
    if (document.getElementById('wssnet-styles')) return;
    const s = document.createElement('style');
    s.id = 'wssnet-styles';
    s.textContent = `
      :root {
        --wssnet-accent:   #4caf50;
        --wssnet-bg:       #000c;
        --wssnet-card-bg:  #0d2b18;
        --wssnet-font:     'Segoe UI', monospace;
        --wssnet-radius:   14px;
        --wssnet-error:    #ff6b6b;
      }
      .wssnet-overlay {
        position: fixed; inset: 0;
        background: var(--wssnet-bg);
        display: flex; align-items: center; justify-content: center;
        z-index: 9000;
        font-family: var(--wssnet-font);
      }
      .wssnet-card {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        background: var(--wssnet-card-bg);
        border: 1px solid #ffffff18;
        border-radius: var(--wssnet-radius);
        padding: 32px 28px;
        width: min(320px, 90vw);
        color: white;
      }
      .wssnet-title {
        font-size: 20px; font-weight: bold; letter-spacing: 2px; margin-bottom: 4px;
      }
      .wssnet-hint {
        font-size: 12px; color: #aaa; text-align: center;
      }
      .wssnet-code {
        background: #ffffff18; border: 1px solid #ffffff30;
        padding: 10px 24px; border-radius: 8px;
        font-size: 28px; letter-spacing: 6px; font-weight: bold;
      }
      .wssnet-input {
        padding: 10px 14px; font-size: 15px;
        border-radius: 8px; border: none;
        background: #ffffffdd; color: #000;
        width: 100%;
        font-family: var(--wssnet-font);
      }
      .wssnet-input-center { text-align: center; letter-spacing: 4px; font-size: 20px; }
      .wssnet-btn {
        width: 100%; padding: 12px;
        font-size: 16px; font-weight: bold; letter-spacing: 1px;
        border-radius: 8px; border: none;
        background: var(--wssnet-accent); color: white;
        cursor: pointer; margin-top: 4px;
        font-family: var(--wssnet-font);
      }
      .wssnet-btn:active { opacity: 0.85; }
      .wssnet-error {
        font-size: 12px; color: var(--wssnet-error); min-height: 16px; text-align: center;
      }
    `;
    document.head.appendChild(s);
  }
}