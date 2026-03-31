# Multiplayer Sync Pattern — SYN/ACK with Retries

A robust, simple pattern for real-time 2-player browser games over a WebSocket relay.
No dedicated game server needed. **Turn ownership rotates** — whoever's turn it is owns
all logic and randomness for that turn, then broadcasts the result.

---

## Core Principles

- **Turn owner acts locally**: roll dice, update state, then broadcast. No middleman.
- **Both clients persist everything** to `sessionStorage` after every action.
- **No resync on reconnect**: each client loads its own storage and resumes. The sender resends any unACKed message.
- **Duplicate delivery is safe**: every message has a sequence number; already-applied messages are ignored.
- **One initialiser**: the lower ID sets up the initial state and sends it. After that, both sides are equal.

---

## Roles

There are no permanent roles. **Whoever's turn it is owns that turn completely.**

The lower ID has one special responsibility: initialising the game state and sending the first message (`seq=0`). After that, turn ownership alternates with the game.

```js
// Deterministic — requires no coordination
const iInitialiser = myId < peerId;
```

---

## Message Types

Only **2 message types** are needed:

### 1. `state` (Active player → Opponent)
Sent after every action by whoever's turn it is. Contains the complete board.

```json
{
  "type": "state",
  "seq": 5,
  "state": { "...completeBoard": "..." }
}
```

- `seq` starts at `0` (initial setup) and increments by 1 on every send.
- Always send the **complete** game state — never a diff.

### 2. `ack` (Receiver → Sender)
Sent immediately upon receiving any `state` message.

```json
{
  "type": "ack",
  "seq": 5
}
```

That's it. No `action` messages, no negotiation, no resync requests.

---

## Active Player Flow

```
User acts (roll, move, score, etc.)
  → update state locally
  → seq++
  → saveAll()
  → net.send({ type:'state', seq, state })
  → startRetry(msg)
  → render()

Receive { type:'ack', seq }
  → if seq matches pendingMsg.seq → stopRetry(), saveAll()
```

## Receiving Player Flow

```
Receive { type:'state', seq, state }
  → net.send({ type:'ack', seq })       // always, immediately
  → if seq <= lastAppliedSeq → return   // duplicate, ignore
  → lastAppliedSeq = seq
  → apply state
  → saveAll()
  → render()
```

---

## Retry Logic

The sender retries unACKed messages on a fixed interval.

```js
const RETRY_MS  = 5000;  // retry every 5s
const RETRY_MAX = 12;    // give up after 60s total

function startRetry(msg) {
  stopRetry();
  pendingMsg = msg;
  retryCt = 0;
  retryTimer = setInterval(() => {
    retryCt++;
    if (retryCt > RETRY_MAX) {
      stopRetry();
      showBanner('Opponent unreachable…');
      return;
    }
    net.send(pendingMsg);
  }, RETRY_MS);
}

function stopRetry() {
  clearInterval(retryTimer);
  retryTimer = null;
  pendingMsg = null;
  retryCt = 0;
}
```

---

## Persistence

Save **everything** to `sessionStorage` after every action.
This survives page reloads but is isolated per browser tab.

```js
function saveAll() {
  sessionStorage.setItem('game_save', JSON.stringify({
    myId, peer,
    seq, lastAppliedSeq,
    pendingMsg,   // the unACKed msg, if any — null if ACKed
    state         // complete game state
  }));
}

function loadAll() {
  const d = JSON.parse(sessionStorage.getItem('game_save'));
  if (!d) return false;
  ({ myId, peer, seq, lastAppliedSeq, pendingMsg, state } = d);
  return true;
}
```

**Use `localStorage` for URL/server preferences.**
**Use `sessionStorage` for game state and player IDs.**
sessionStorage is tab-isolated — critical when two players share the same device/browser.

---

## Reconnect Flow

```js
onReconnected(peerId) {
  peer = peerId;

  if (loadAll()) {
    render();
    // If we had an unACKed message pending, resend immediately
    if (pendingMsg) {
      retryCt = 0;
      net.send(pendingMsg);
    }
  }
}
```

No resync requests. No asking the other player for state. Just load storage and resume.
The opponent's retry loop will already be resending their last message if it was unACKed.

---

## Initial Setup (seq=0)

The lower ID initialises the board and sends `seq=0`. The opponent receives it, ACKs,
and from that point both sides are in sync and equal.

```js
onPaired(myId, peerId) {
  if (myId < peerId) {
    state = initialState(peerId); // e.g. higher ID goes first
    seq = 0;
    lastAppliedSeq = -1;
    const msg = { type:'state', seq, state };
    saveAll();
    net.send(msg);
    startRetry(msg);
  }
  startGame();
}
```

---

## When to use a permanent host instead

Turn-based ownership works perfectly when **each turn is self-contained** — the acting
player has all the information they need to resolve their own turn.

Consider a permanent host (one client owns all logic) only if:
- Actions from one player need to be **validated against hidden state** the other player holds
- **Simultaneous actions** from both players need to be resolved at the same time
- The game has **server-authoritative randomness** that neither client should control

For most turn-based games, turn ownership is the simpler and correct choice.

---

## What NOT to do

- ❌ Don't resync on reconnect by asking the peer for their state
- ❌ Don't send partial state / diffs — always send complete state
- ❌ Don't use `localStorage` for game state (shared across tabs)
- ❌ Don't skip `saveAll()` between actions — storage must always mirror live state
- ❌ Don't add a third message type for player actions — the turn owner acts locally