let ws;
let myId;
let myName;
let localStream;
let audioTrack;
let floorHolder = null; // id of whoever currently holds the channel
let wantTalk = false; // PTT physically held right now (set before the server grants)
let lastMsgAt = 0; // last time anything arrived from the server
const peers = new Map(); // id -> RTCPeerConnection
const audioEls = new Map();
let reconnectTimer = null;
let backoff = 1000;

const pttBtn = document.getElementById('ptt');
const statusEl = document.getElementById('status');
const peerListEl = document.getElementById('peer-list');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const setupEl = document.getElementById('setup');
const talkEl = document.getElementById('talk');

const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Roger beep. The server decides (ROGER_BEEP) and announces it in `welcome`;
// off until told otherwise. Played locally with Web Audio when the channel
// goes from someone talking to free, so it never touches the voice path.
//
// A MOTOTRBO-style talk-permit warble: four back-to-back notes (G6 C6 G6 E6,
// 200 ms in all). cli/lan_walkie_cli.py plays the same notes (BEEP_PATTERN);
// change both together.
const BEEP_PATTERN = [
  { freq: 1568, ms: 80 },
  { freq: 1046.5, ms: 40 },
  { freq: 1568, ms: 40 },
  { freq: 1318.5, ms: 40 },
];
const BEEP_LEVEL = 0.7;
let rogerBeep = false;
let beepCtx = null;
const beepHintEl = document.getElementById('beep-hint');

// Shown while the beep is on but the browser is still blocking sound: without
// this a phone that only listens would stay silent and nobody would know why.
function updateBeepHint() {
  const locked = rogerBeep && (!beepCtx || beepCtx.state !== 'running');
  beepHintEl.classList.toggle('hidden', !locked);
}

// Browsers only allow audio after a user gesture, and a returning visitor
// auto-joins without one, so unlock on the first touch/click/key instead.
function unlockBeepAudio() {
  try {
    if (!beepCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      beepCtx = new Ctx();
      beepCtx.onstatechange = updateBeepHint;
    }
    if (beepCtx.state !== 'running') beepCtx.resume().then(updateBeepHint, () => {});
    updateBeepHint();
  } catch {}
}
for (const evt of ['pointerdown', 'touchend', 'keydown', 'click']) {
  window.addEventListener(evt, unlockBeepAudio, { passive: true });
}

function playRogerBeep() {
  if (receiveMuted()) return;
  try {
    if (!beepCtx || beepCtx.state !== 'running') return; // not unlocked yet: stay silent
    // One oscillator for the whole warble, so the phase stays continuous when
    // the pitch jumps (separate oscillators would click at every change).
    // Fundamental plus a little third harmonic gives it a small speaker's bite.
    const wave = beepCtx.createPeriodicWave(new Float32Array(4), new Float32Array([0, 0.93, 0, 0.07]));
    const osc = beepCtx.createOscillator();
    osc.setPeriodicWave(wave);
    const env = beepCtx.createGain();
    // 300-3400 Hz band, like a handheld's speaker path.
    const hp = beepCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = beepCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    const out = beepCtx.createGain();
    out.gain.value = BEEP_LEVEL;
    osc.connect(env).connect(hp).connect(lp).connect(out).connect(beepCtx.destination);

    const start = beepCtx.currentTime + 0.01;
    let t = start;
    for (const note of BEEP_PATTERN) {
      osc.frequency.setValueAtTime(note.freq, t);
      t += note.ms / 1000;
    }
    // 2 ms fades at each end so the warble doesn't click.
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + 0.002);
    env.gain.setValueAtTime(1, t - 0.002);
    env.gain.linearRampToValueAtTime(0, t);
    osc.start(start);
    osc.stop(t + 0.02);
  } catch {}
}

// The floor is exclusive — you never hear your own remote peers while
// transmitting, so there's no full-duplex/echo scenario here. Browser echo
// cancellation/noise suppression/AGC add real processing latency for a
// benefit this app structurally doesn't need; turn them off.
const audioConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const NAME_KEY = 'walkie-name';
const myNameLabel = document.getElementById('my-name-label');
const changeNameLink = document.getElementById('change-name');

joinBtn.addEventListener('click', () => join(nameInput.value.trim()));
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(nameInput.value.trim()); });
changeNameLink.addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem(NAME_KEY);
  location.reload();
});

// Screen wake lock. A locked screen hides the page: received audio is muted
// and the page stops answering the server, which then drops the phone as a
// dead connection. The lock only stops the automatic screen timeout while the
// app is in the foreground; the browser takes it away whenever the page is
// hidden, so it is asked for again each time the page comes back.
//
// Modes: 'always' (while the app is open), 'active' (while someone talks and
// for WAKE_IDLE_MS after the last floor change, own PTT or touch), 'off'.
const WAKE_KEY = 'walkie-wake';
const WAKE_MODES = ['always', 'active', 'off'];
const WAKE_DEFAULT = 'always';
const WAKE_IDLE_MS = 10 * 60 * 1000;
const wakeSelect = document.getElementById('wake-mode');
const wakeStatusEl = document.getElementById('wake-status');
const wakeSupported = !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
let wakeMode = WAKE_DEFAULT;
let wakeLock = null; // the lock we hold, if any
let wakePending = false; // a request is in flight: never start a second one
let wakeFailed = false; // the last request was refused (battery saver, iframe without permission)
let wakeSession = false; // set once the first socket opens; kept across automatic reconnects
let wakeIdleTimer = null;
let lastActivityAt = 0;

try {
  const saved = localStorage.getItem(WAKE_KEY);
  if (WAKE_MODES.includes(saved)) wakeMode = saved;
} catch {}
wakeSelect.value = wakeMode;
wakeSelect.disabled = !wakeSupported;
wakeSelect.addEventListener('change', () => setWakeMode(wakeSelect.value));

function setWakeMode(mode) {
  if (!WAKE_MODES.includes(mode)) return;
  wakeMode = mode;
  try { localStorage.setItem(WAKE_KEY, mode); } catch {}
  lastActivityAt = Date.now();
  updateWakeLock();
}

function wakeWanted() {
  if (!wakeSupported || !wakeSession || document.hidden || wakeMode === 'off') return false;
  if (wakeMode === 'always') return true;
  return !!floorHolder || Date.now() - lastActivityAt < WAKE_IDLE_MS;
}

function renderWakeStatus() {
  let text;
  if (!wakeSupported) text = "This browser can't keep the screen on. Set a longer screen timeout on the phone.";
  else if (wakeLock) text = 'Screen stays on';
  else if (wakeMode === 'off' || !wakeSession) text = '';
  else if (wakeFailed) text = "Couldn't keep the screen on (battery saver?)";
  else if (wakeMode === 'active' && !wakeWanted()) text = 'Idle: screen may turn off';
  else text = '';
  wakeStatusEl.textContent = text;
}

// Brings the lock in line with what the mode wants right now. Safe to call
// from anywhere, any number of times.
function updateWakeLock() {
  clearTimeout(wakeIdleTimer);
  wakeIdleTimer = null;
  const want = wakeWanted();
  if (want && wakeMode === 'active' && !floorHolder) {
    wakeIdleTimer = setTimeout(updateWakeLock, lastActivityAt + WAKE_IDLE_MS - Date.now());
  }
  if (want) {
    if (!wakeLock && !wakePending) requestWakeLock();
  } else if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try { Promise.resolve(lock.release()).catch(() => {}); } catch {}
  }
  renderWakeStatus();
}

async function requestWakeLock() {
  wakePending = true;
  let lock = null;
  try {
    lock = await navigator.wakeLock.request('screen');
  } catch {}
  wakePending = false;
  wakeFailed = !lock;
  if (!lock) {
    // Not retried here (a refusal would loop); the next touch, floor change
    // or return to the foreground asks again.
    renderWakeStatus();
    return;
  }
  // The browser releases the lock by itself when the page is hidden.
  lock.addEventListener('release', () => {
    if (wakeLock !== lock) return;
    wakeLock = null;
    updateWakeLock();
  });
  wakeLock = lock;
  updateWakeLock(); // the mode or visibility may have changed while waiting
}

function noteActivity() {
  lastActivityAt = Date.now();
  if (wakeSession) updateWakeLock();
}
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, noteActivity, { passive: true });
}
renderWakeStatus();

// Received audio while the page is hidden. Phones stay silent in the
// background, as before. A desktop tab keeps playing (a setting, on by
// default): calls used to be lost to a tab that was merely behind another one.
const BG_AUDIO_KEY = 'walkie-bg-audio';
const userAgent = String(navigator.userAgent || '');
const isPhone = navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean'
  ? navigator.userAgentData.mobile
  : /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
const bgAudioRow = document.getElementById('bg-audio-row');
const bgAudioCheck = document.getElementById('bg-audio');
let bgAudio = false;
if (!isPhone) {
  try { bgAudio = localStorage.getItem(BG_AUDIO_KEY) !== 'off'; } catch { bgAudio = true; }
  bgAudioRow.classList.remove('hidden');
  bgAudioCheck.checked = bgAudio;
  bgAudioCheck.addEventListener('change', () => setBgAudio(bgAudioCheck.checked === true));
}

function setBgAudio(on) {
  if (isPhone) return;
  bgAudio = !!on;
  try { localStorage.setItem(BG_AUDIO_KEY, bgAudio ? 'on' : 'off'); } catch {}
  applyReceiveMute();
  sendPresence();
}

const receiveMuted = () => document.hidden && !bgAudio;

function applyReceiveMute() {
  for (const el of audioEls.values()) el.muted = receiveMuted();
}

// Tells the server whether this page is on screen and whether it is playing
// received audio, so the usage records can say if anyone could hear a call.
function sendPresence() {
  wsSend({ type: 'presence', visible: !document.hidden, audible: !receiveMuted() });
}

// A call that arrives while the page is hidden is shown in the tab title and,
// where the browser supports it, as a badge on the installed app's icon. It
// stays until the page is looked at again.
const BASE_TITLE = 'LAN Walkie';
let floorName = null; // name of whoever holds the floor
let missedCaller = null; // someone talked while the page was hidden
let noticeShown = false;

function updateCallNotice() {
  const talking = floorHolder && floorHolder !== myId ? String(floorName || 'Someone') : null;
  if (!document.hidden) missedCaller = null;
  else if (talking) missedCaller = talking;
  let title = BASE_TITLE;
  if (document.hidden && talking) title = `● ${talking} talking`;
  else if (missedCaller) title = `● ${missedCaller} called`;
  document.title = title;
  const show = title !== BASE_TITLE;
  if (show === noticeShown) return;
  noticeShown = show;
  try {
    const fn = show ? navigator.setAppBadge : navigator.clearAppBadge;
    if (typeof fn === 'function') Promise.resolve(fn.call(navigator)).catch(() => {});
  } catch {}
}

// One id per browser profile, so the usage records can tell devices apart
// even when two people pick the same name. Random, never derived from anything.
const DEVICE_KEY = 'walkie-device';
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || '')) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return undefined; // the server derives one
  }
}

let joining = false;
let rosterIds = new Set(); // peers the server currently lists
const retryCounts = new Map(); // peer id -> how many times we re-offered to a peer that never called us back

// The browser can end the microphone track by itself (device unplugged,
// permission revoked, another app took it). An ended track cannot be turned
// back on, so get a new one and hand it to every open connection.
function watchMic(track) {
  track.addEventListener('ended', () => { if (track === audioTrack) reacquireMic(); });
}

let reacquiring = false;
async function reacquireMic() {
  if (reacquiring) return;
  reacquiring = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const track = stream.getAudioTracks()[0];
    track.enabled = false;
    const old = localStream;
    localStream = stream;
    audioTrack = track;
    watchMic(track);
    for (const pc of peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track === null || sender.track.kind === 'audio') sender.replaceTrack(track).catch(() => {});
      }
    }
    if (old) old.getTracks().forEach((t) => t.stop());
    wantTalk = false;
    pttBtn.classList.remove('active');
  } catch {
    pttBtn.disabled = true;
    statusEl.textContent = 'Microphone lost. Allow the mic and reload.';
  } finally {
    reacquiring = false;
  }
}

async function join(name) {
  if (joining) return; // a second tap while the mic prompt is open must not start a second session
  joining = true;
  myName = name || 'Anon';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (e) {
    joining = false;
    alert('Microphone access denied. Allow the mic in your browser settings and reload.');
    return;
  }
  localStorage.setItem(NAME_KEY, myName);
  audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = false; // muted until PTT is held
  watchMic(audioTrack);
  setupEl.classList.add('hidden');
  talkEl.classList.remove('hidden');
  myNameLabel.textContent = myName;
  connect();
}

// Remembered from a previous visit — names rarely change on a given device,
// so skip straight past the name prompt instead of asking every time.
const savedName = localStorage.getItem(NAME_KEY);
if (savedName) {
  join(savedName);
}

// Sends only if the current socket is open; a socket we just abandoned must
// not throw into WebRTC event handlers.
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  // Events from a socket we've already abandoned (a half-dead one after a
  // Wi-Fi roam) must never touch current state, so every handler checks that
  // it still belongs to the live socket.
  const sock = new WebSocket(`wss://${location.host}`);
  ws = sock;
  lastMsgAt = Date.now();
  pttBtn.disabled = true;

  sock.addEventListener('open', () => {
    if (sock !== ws) return;
    statusEl.textContent = 'Connected';
    pttBtn.disabled = false;
    backoff = 1000;
    if (!wakeSession) {
      wakeSession = true;
      lastActivityAt = Date.now();
    }
    updateWakeLock();
  });
  sock.addEventListener('close', () => {
    if (sock === ws) scheduleReconnect();
  });

  sock.addEventListener('message', async (event) => {
    if (sock !== ws) return;
    lastMsgAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong') return;

    if (msg.type === 'welcome') {
      myId = msg.id;
      rogerBeep = msg.rogerBeep === true;
      updateBeepHint();
      wsSend({ type: 'join', name: myName, device: deviceId(), role: 'browser' });
      sendPresence();
      return;
    }

    if (msg.type === 'peers') {
      const incomingIds = new Set(msg.peers.map((p) => p.id));
      rosterIds = incomingIds;
      for (const p of msg.peers) {
        if (!peers.has(p.id)) createPeer(p.id, myId < p.id);
      }
      for (const id of [...peers.keys()]) {
        if (!incomingIds.has(id)) { removePeer(id); retryCounts.delete(id); }
      }
      renderPeerList(msg.peers);
      return;
    }

    if (msg.type === 'offer') {
      // A second offer from a peer we already negotiated with means it
      // rebuilt its connection (e.g. after a Wi-Fi roam). Its new connection
      // has a new DTLS identity, so start fresh instead of renegotiating.
      const existing = peers.get(msg.from);
      if (existing && existing.signalingState === 'have-local-offer') {
        // Both sides offered at once. The lower id's offer wins, same rule as at first contact.
        if (myId < msg.from) return;
        removePeer(msg.from);
      } else if (existing && existing.remoteDescription) removePeer(msg.from);
      const pc = peers.get(msg.from) || createPeer(msg.from, false);
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'answer', target: msg.from, sdp: pc.localDescription });
      return;
    }

    if (msg.type === 'answer') {
      const pc = peers.get(msg.from);
      if (pc) await pc.setRemoteDescription(msg.sdp);
      return;
    }

    if (msg.type === 'ice') {
      const pc = peers.get(msg.from);
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
      return;
    }

    if (msg.type === 'floor') {
      const previousHolder = floorHolder;
      floorHolder = msg.holder;
      floorName = msg.name;
      noteActivity();
      updateCallNotice();
      if (floorHolder === myId) {
        if (!wantTalk) {
          // The button was released before the grant arrived. Give the
          // floor straight back instead of holding an open mic until the
          // server's transmit timeout.
          audioTrack.enabled = false;
          wsSend({ type: 'ptt-stop' });
          return;
        }
        audioTrack.enabled = true;
        pttBtn.classList.add('active');
        setPttLabel('TALKING');
      } else if (floorHolder) {
        audioTrack.enabled = false;
        pttBtn.classList.remove('active');
        setPttLabel(`${msg.name} IS TALKING`, !!msg.priority);
      } else {
        audioTrack.enabled = false;
        pttBtn.classList.remove('active');
        setPttLabel('HOLD TO TALK');
        // Someone was talking and now nobody is. A hand-over to another
        // speaker (priority preemption) is not "free", so no beep there.
        if (rogerBeep && previousHolder) playRogerBeep();
      }
      return;
    }

    if (msg.type === 'floor-denied') {
      noteActivity();
      setPttLabel(`${msg.name} IS TALKING`);
      return;
    }

    if (msg.type === 'floor-preempted') {
      statusEl.textContent = '';
      statusEl.append('Interrupted by ', priorityMark(), String(msg.by));
      setTimeout(() => { statusEl.textContent = 'Connected'; }, 3000);
      return;
    }
  });
}

// A phone that changes access point often keeps a TCP connection that looks
// open but carries nothing; the browser can take minutes to notice. Ping the
// server and treat silence as a dead connection.
const HEARTBEAT_MS = 4000;
const DEAD_AFTER_MS = 12000;

function dropSocketAndReconnect() {
  const dead = ws;
  ws = null; // handlers of the abandoned socket now ignore themselves
  if (dead) {
    try { dead.close(); } catch {}
  }
  scheduleReconnect();
}

setInterval(() => {
  if (!ws || reconnectTimer) return;
  if (ws.readyState === WebSocket.OPEN) {
    if (Date.now() - lastMsgAt > DEAD_AFTER_MS) {
      dropSocketAndReconnect();
    } else {
      try { wsSend({ type: 'ping' }); } catch {}
    }
  } else if (ws.readyState === WebSocket.CONNECTING && Date.now() - lastMsgAt > DEAD_AFTER_MS) {
    dropSocketAndReconnect();
  }
}, HEARTBEAT_MS);

// Coming back online / back to the foreground: check right away instead of
// waiting for the next heartbeat.
function checkNow() {
  if (!myName || reconnectTimer) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  lastMsgAt = Math.min(lastMsgAt, Date.now() - DEAD_AFTER_MS + 2000);
}
window.addEventListener('online', checkNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNow(); });

// Wi-Fi roaming between rooms/access points looks exactly like a dropped
// connection to the browser — the previous behavior ("Disconnected — reload
// to rejoin") required a human to notice and act, which doesn't work for
// non-technical users. Reconnect automatically instead, same
// backoff shape as the CLI's connection_loop() (1s → 2s → 4s... capped at
// 30s, reset to 1s on success).
function scheduleReconnect() {
  if (reconnectTimer) return;
  statusEl.textContent = 'Reconnecting…';
  pttBtn.disabled = true;
  resetForReconnect();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

// The server hands out a fresh id and peer list on rejoin — anything tied
// to the old connection (peer ids, in-flight WebRTC connections, floor
// state) is meaningless once it's gone and must not linger into the next
// session.
function resetForReconnect() {
  for (const id of [...peers.keys()]) removePeer(id);
  retryCounts.clear();
  floorHolder = null;
  floorName = null;
  updateCallNotice();
  wantTalk = false;
  if (audioTrack) audioTrack.enabled = false;
  pttBtn.classList.remove('active');
  setPttLabel('HOLD TO TALK');
  // The wake lock is deliberately kept: letting the screen lock during a
  // reconnect would hide the page and stop the reconnect from working.
  updateWakeLock();
}

// The priority marker is always a separate element, never a prefix inside
// the name string: peers choose their own names, so an in-band "⭐ " would be
// indistinguishable from the real marker. The server also strips ⭐ from names.
function priorityMark() {
  const span = document.createElement('span');
  span.className = 'priority-mark';
  span.textContent = '⭐ ';
  return span;
}

function setPttLabel(text, priority = false) {
  pttBtn.textContent = '';
  if (priority) pttBtn.append(priorityMark());
  pttBtn.append(text);
}

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection(config);
  peers.set(id, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.addEventListener('track', (event) => {
    let audioEl = audioEls.get(id);
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.autoplay = true;
      audioEls.set(id, audioEl);
    }
    audioEl.srcObject = event.streams[0];
    audioEl.muted = receiveMuted(); // phones play nothing while the app is in the background

    // Chrome-only, silently ignored elsewhere: shrinks the jitter buffer's
    // target delay. Worth trading a little resilience to network jitter for
    // lower mouth-to-ear latency on a LAN.
    try { event.receiver.playoutDelayHint = 0; } catch {}
  });

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      wsSend({ type: 'ice', target: id, candidate: event.candidate });
    }
  });

  // A broken Wi-Fi path (a roam between access points, mid-call) shows up
  // here as 'failed' — with no recovery, that peer just stays silently dead
  // until someone reloads. Rebuild it instead. Deliberately not reacting to
  // 'disconnected': browsers routinely recover from that on their own (it's
  // often just a brief packet-loss blip) and escalate to 'failed' themselves
  // if it doesn't resolve — acting earlier would tear down connections that
  // were about to heal on their own.
  //
  // Roaming update: 'disconnected' that doesn't heal within a few seconds is
  // treated like 'failed'. Waiting for the browser to escalate on its own
  // left phones silent for far too long after switching access points.
  let disconnectTimer = null;
  function recover() {
    if (peers.get(id) !== pc) return; // already replaced
    removePeer(id);
    if (myId < id) {
      createPeer(id, true); // negotiationneeded fires a fresh offer automatically
    }
    // Non-initiator side waits for that new offer, same as first contact —
    // see the 'offer' handler in connect(). The gateway never initiates a
    // new offer, so if none arrives this side makes the offer itself, for THIS
    // peer only: connections that work are left alone. Retries back off.
    else {
      const sock = ws;
      const attempt = (retryCounts.get(id) || 0) + 1;
      retryCounts.set(id, attempt);
      setTimeout(() => {
        if (ws === sock && sock && rosterIds.has(id) && !peers.has(id)) createPeer(id, true);
      }, Math.min(8000 * attempt, 30000));
    }
  }
  pc.addEventListener('iceconnectionstatechange', () => {
    clearTimeout(disconnectTimer);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      retryCounts.delete(id); // it works: forget earlier failed attempts
    } else if (pc.iceConnectionState === 'failed') {
      recover();
    } else if (pc.iceConnectionState === 'disconnected') {
      disconnectTimer = setTimeout(recover, 4000);
    }
  });

  if (initiator) {
    pc.addEventListener('negotiationneeded', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'offer', target: id, sdp: pc.localDescription });
    });
  }

  return pc;
}

function removePeer(id) {
  const pc = peers.get(id);
  if (pc) pc.close();
  peers.delete(id);
  const audioEl = audioEls.get(id);
  if (audioEl) audioEl.srcObject = null;
  audioEls.delete(id);
}

function renderPeerList(list) {
  peerListEl.innerHTML = '';
  if (list.length === 0) {
    peerListEl.innerHTML = '<li class="empty">No one else here yet</li>';
    return;
  }
  for (const p of list) {
    const li = document.createElement('li');
    if (p.priority) li.appendChild(priorityMark());
    li.append(String(p.name));
    peerListEl.appendChild(li);
  }
}

function startTalk() {
  if (!audioTrack || floorHolder || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (audioTrack.readyState === 'ended') { reacquireMic(); return; } // never claim the floor with a dead mic
  wantTalk = true;
  wsSend({ type: 'ptt-start' });
}

function stopTalk() {
  wantTalk = false;
  // Close the microphone at once, locally. Waiting for the server's release
  // would leave it live whenever signaling is slow or stalled.
  if (audioTrack) audioTrack.enabled = false;
  pttBtn.classList.remove('active');
  if (!audioTrack || floorHolder !== myId || !ws || ws.readyState !== WebSocket.OPEN) return;
  wsSend({ type: 'ptt-stop' });
}

pttBtn.addEventListener('pointerdown', startTalk);
pttBtn.addEventListener('pointerup', stopTalk);
pttBtn.addEventListener('pointercancel', stopTalk);
pttBtn.addEventListener('pointerleave', stopTalk);
pttBtn.addEventListener('lostpointercapture', stopTalk);

// Mobile browsers treat a held-down touch as a long-press gesture and pop up
// their own share/save/copy menu, which steals the touch — that fires
// pointercancel mid-transmission and looks like PTT randomly cutting out
// after about a second. CSS (touch-action, -webkit-touch-callout) heads most
// of this off; this is the last-resort backstop for whatever slips through.
pttBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// Defensive releases: if the tab is backgrounded, the device sleeps, or the
// window loses focus mid-transmission, don't leave the channel locked.
window.addEventListener('blur', stopTalk);
window.addEventListener('pagehide', stopTalk);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTalk();
  // Received audio is muted (not torn down, so no tap is needed to resume)
  // while hidden, except on a desktop with background audio on.
  applyReceiveMute();
  updateCallNotice();
  sendPresence();
  updateWakeLock(); // the browser dropped the lock when the page was hidden: ask again
});

window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat) startTalk(); });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') stopTalk(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
