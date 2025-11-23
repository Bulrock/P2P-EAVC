/* ============================================
   ICE SERVERS (STUN + optional TURN)
============================================ */
const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  // Add your TURN here:
  // {
  //   urls: "turn:your.turn.server:3478",
  //   username: "user",
  //   credential: "pass"
  // }
];

/* ============================================
   Global State
============================================ */
let pc = null;
let dataChannel = null;
let sharedKey = null;
let localStream = null;
let remoteStream = null;
let isHost = null;
const pendingChunks = new Map();
const CHUNK_SIZE = 8000;
let mediaRecorder = null;
let audioChunks = [];
let micAllowed = false;
let micRequesting = false;
let micRequested = false;
let typingTimeout = null;
let lastTypingState = false;
const messageReactions = new Map(); // id -> Map(emoji -> { host:bool, guest:bool })
const REACTION_EMOJIS = ["👍", "😂", "😍", "🔥", "👏", "💩"];
const messageBodies = new Map(); // id -> last text body for edits

// for correct connection status
let iceState = "new";
let dcOpen = false;

const logEl = document.getElementById("log");
const connDot = document.getElementById("connDot");
const connStatus = document.getElementById("connStatus");
const connHeader = document.getElementById("connHeader");
const connBody = document.getElementById("connBody");
const connChevron = document.getElementById("connChevron");
let connCollapsed = false;

const chatStatus = document.getElementById("chatStatus");
const chatMessages = document.getElementById("chatMessages");

const offerOut = document.getElementById("offerOut");
const offerIn = document.getElementById("offerIn");
const answerOut = document.getElementById("answerOut");
const answerIn = document.getElementById("answerIn");
const chatInput = document.getElementById("chatInput");
const btnSend = document.getElementById("btnSend");
const emojiSelect = document.getElementById("emojiSelect");
const photoInput = document.getElementById("photoInput");
const btnPhoto = document.getElementById("btnPhoto");
const btnRecord = document.getElementById("btnRecord");

const modeToggle = document.getElementById("modeToggle");

const mediaCheckbox = document.getElementById("chkMedia");
const videoWrapper = document.getElementById("videoWrapper");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const flowSection = document.getElementById("flowSection");
const flowHeader = document.getElementById("flowHeader");
const flowChevron = document.getElementById("flowChevron");
const flowTitle = document.getElementById("flowTitle");
const flowPill = document.getElementById("flowPill");
const logHeader = document.getElementById("logHeader");
const logBody = document.getElementById("logBody");
const mainEl = document.querySelector("main");

const btnDisconnect = document.getElementById("btnDisconnect");

logHeader.addEventListener("click", () => {
  logBody.classList.toggle("collapsed");
  logHeader.textContent = logBody.classList.contains("collapsed")
    ? "Log ▸"
    : "Log ▾";
});

flowHeader.addEventListener("click", () => {
  const collapsed = flowSection.classList.contains("collapsed");
  setFlowCollapsed(!collapsed);
});

btnDisconnect.addEventListener("click", () => {
  resetState();
  btnDisconnect.disabled = true;
});

/* ============================================
   Accordion helpers
============================================ */
function setAccordionCollapsed(collapsed) {
  connCollapsed = collapsed;
  connBody.style.display = collapsed ? "none" : "";
  connChevron.textContent = collapsed ? "▸" : "▾";
  if (collapsed) {
    mainEl.classList.add("main-collapsed");
  } else {
    mainEl.classList.remove("main-collapsed");
  }
}

connHeader.addEventListener("click", () => {
  setAccordionCollapsed(!connCollapsed);
});

/* ============================================
   UI Helpers
============================================ */
function setFlowCollapsed(collapsed) {
  flowSection.classList.toggle("collapsed", collapsed);
  flowChevron.textContent = collapsed ? "▸" : "▾";
}

function updateFlowHeaderText() {
  if (isHost) {
    flowTitle.textContent = "Host flow";
    flowPill.textContent = "You start the call";
  } else {
    flowTitle.textContent = "Guest flow";
    flowPill.textContent = "You join the call";
  }
}

function updateSendControls() {
  const ready = dataChannel && dataChannel.readyState === "open" && sharedKey;
  btnSend.disabled = !ready;
  btnPhoto.disabled = !ready;
  if (ready && !micAllowed && !micRequesting && !micRequested) {
    micRequesting = true;
    micRequested = true;
    requestMicPermission().finally(() => {
      micRequesting = false;
      updateSendControls();
    });
  }

  const micBlocked = micRequested && !micAllowed;
  btnRecord.disabled = !ready || micBlocked;
  emojiSelect.disabled = !ready;
  photoInput.disabled = !ready;
  chatInput.disabled = !ready;
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${msg}`;
  console.log(line);
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setConnectionStatus(label) {
  connDot.classList.remove("connected", "disconnected", "connecting");

  if (label === "Connected") {
    connDot.classList.add("connected");

    btnDisconnect.disabled = false;

    if (mediaCheckbox.checked) {
      setFlowCollapsed(true);
      logBody.classList.add("collapsed");
      logHeader.textContent = "Log ▸";
    } else {
      setAccordionCollapsed(true);
    }
  } else if (label === "Connecting…") {
    connDot.classList.add("connecting");
  } else {
    connDot.classList.add("disconnected");
    btnDisconnect.disabled = true;
  }

  connStatus.textContent = label;
}

function recomputeConnectionStatus() {
  const iceReady = iceState === "connected" || iceState === "completed";

  if (iceReady && dcOpen) {
    setConnectionStatus("Connected");
  } else if (iceReady || dcOpen) {
    setConnectionStatus("Connecting…");
  } else {
    setConnectionStatus("Disconnected");
  }
}

function setChatStatus(text) {
  chatStatus.textContent = text;
  updateSendControls();
}

function setTypingIndicator(active) {
  const peerLabel = getPeerLabel();
  let bubble = document.getElementById("typingBubble");
  if (active) {
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "typingBubble";
      bubble.className = "msg peer";
      const inner = document.createElement("div");
      inner.className = "bubble";
      inner.textContent = `${peerLabel} is typing…`;
      bubble.appendChild(inner);
      chatMessages.appendChild(bubble);
    } else {
      const inner = bubble.querySelector(".bubble");
      if (inner) inner.textContent = `${peerLabel} is typing…`;
    }
    bubble.style.display = "flex";
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else if (bubble) {
    bubble.remove();
  }
}

function getPeerLabel() {
  if (isHost === true) return "Guest";
  if (isHost === false) return "Host";
  return "Peer";
}

function getActorRole() {
  if (isHost === true) return "host";
  if (isHost === false) return "guest";
  return "peer";
}

function attachReactionMenu(wrapper) {
  const menu = wrapper.querySelector(".react-menu");
  if (!menu) return;
  let hideTimer = null;

  const open = () => {
    hideTimer && clearTimeout(hideTimer);
    wrapper.classList.add("open");
  };

  const close = () => {
    hideTimer && clearTimeout(hideTimer);
    hideTimer = setTimeout(() => wrapper.classList.remove("open"), 150);
  };

  wrapper.addEventListener("mouseenter", open);
  wrapper.addEventListener("mouseleave", close);
  menu.addEventListener("mouseenter", open);
  menu.addEventListener("mouseleave", close);
  const bubble = wrapper.closest(".bubble");
  if (bubble) {
    bubble.addEventListener("mouseenter", open);
    bubble.addEventListener("mouseleave", close);
  }
  wrapper.addEventListener("click", (e) => {
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.classList.contains("react-option") ||
        t.classList.contains("edit-btn") ||
        t.classList.contains("delete-btn"))
    )
      return;
    wrapper.classList.toggle("open");
  });
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
  });
}

function closeReactionMenus() {
  document
    .querySelectorAll(".reactions.open")
    .forEach((el) => el.classList.remove("open"));
}

/* ============================================
   Host/Guest UI Toggle
============================================ */
const hostSection = document.getElementById("hostSection");
const guestSection = document.getElementById("guestSection");

function updateModeUI() {
  if (!modeToggle.checked) {
    // Toggle OFF = HOST
    hostSection.style.display = "";
    guestSection.style.display = "none";
    isHost = true;
    log("UI Mode → HOST");
  } else {
    // Toggle ON = GUEST
    hostSection.style.display = "none";
    guestSection.style.display = "";
    isHost = false;
    log("UI Mode → GUEST");
  }

  updateFlowHeaderText();
}

modeToggle.addEventListener("change", updateModeUI);

/* ============================================
   Media UI toggle
============================================ */
function updateVideoUI() {
  videoWrapper.style.display = mediaCheckbox.checked ? "block" : "none";
}
mediaCheckbox.addEventListener("change", updateVideoUI);

/* ============================================
   Reset State
============================================ */
function resetState() {
  if (pc) pc.close();
  if (dataChannel) dataChannel.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  pc = null;
  dataChannel = null;
  sharedKey = null;
  localStream = null;
  remoteStream = null;
  isHost = null;
  mediaRecorder = null;
  audioChunks = [];
  lastTypingState = false;
  typingTimeout && clearTimeout(typingTimeout);
  typingTimeout = null;

  iceState = "new";
  dcOpen = false;

  offerOut.value = "";
  offerIn.value = "";
  answerOut.value = "";
  answerIn.value = "";
  chatMessages.innerHTML = "";
  logEl.textContent = "";
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  setConnectionStatus("Disconnected");
  setChatStatus("DataChannel: not ready");
  updateSendControls();
  updateVideoUI();
  // default accordion open
  setAccordionCollapsed(false);
  setFlowCollapsed(false);
  updateModeUI();

  log("Ready. Choose Host or Guest to begin.");
}

/* ============================================
   AES-GCM Short Key
============================================ */
function ab2b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b642ab(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

async function generateSharedKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
async function exportKeyBase64(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return ab2b64(raw);
}
async function importKeyBase64(b64) {
  const raw = b642ab(b64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptMessage(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined.buffer;
}

async function decryptMessage(key, data) {
  const bytes = new Uint8Array(data);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

/* ============================================
   WebRTC PeerConnection + DataChannel
============================================ */
function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.oniceconnectionstatechange = () => {
    iceState = pc.iceConnectionState;
    log(`ICE state: ${iceState}`);
    recomputeConnectionStatus();
  };

  pc.ontrack = (event) => {
    log("Remote track received.");
    if (!remoteStream) remoteStream = new MediaStream();
    event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
    remoteVideo.srcObject = remoteStream;
  };

  pc.ondatachannel = (event) => {
    log("Guest: DataChannel received.");
    dataChannel = event.channel;
    setupDataChannelHandlers();
  };
}

async function getLocalMedia() {
  log("Requesting camera/mic…");
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  localVideo.srcObject = localStream;
  log("Local media enabled.");
}

async function waitForIceGatheringComplete() {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((res) => {
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") res();
    });
  });
  log("ICE gathering complete.");
}

function setupDataChannelHandlers() {
  dataChannel.onopen = () => {
    dcOpen = true;
    log("DataChannel open.");
    setChatStatus("DataChannel: open");
    updateSendControls();
    recomputeConnectionStatus();
  };
  dataChannel.onclose = () => {
    dcOpen = false;
    log("DataChannel closed.");
    setChatStatus("DataChannel: closed");
    updateSendControls();
    recomputeConnectionStatus();
  };
  dataChannel.onmessage = async (event) => {
    try {
      const decrypted = await decryptMessage(sharedKey, event.data);
      handleIncomingPayload(decrypted);
    } catch (e) {
      log("Decrypt error: " + e);
    }
  };
}

/* ============================================
   Chat UI
============================================ */
function appendChatMessage(from, payload) {
  if (!payload.id) {
    payload.id = crypto.randomUUID();
  }

  // Remove any existing bubble with same id (e.g., uploading placeholder)
  const existing = chatMessages.querySelector(`[data-mid="${payload.id}"]`);
  if (existing) existing.remove();

  const msg = document.createElement("div");
  msg.className = "msg " + (from === "me" ? "me" : "peer");
  msg.dataset.mid = payload.id;
  if (from === "me") msg.dataset.own = "true";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const small = document.createElement("small");
  small.textContent = from === "me" ? "You" : "Guest";

  const body = document.createElement("div");
  body.className = "msg-body";
  if (payload.type === "image" && payload.imageData) {
    body.textContent = "";
    const img = document.createElement("img");
    img.src = payload.imageData;
    img.alt = payload.name || "Shared image";
    const link = document.createElement("a");
    link.href = payload.imageData;
    link.download = payload.name || "image";
    link.textContent = "Download";
    link.className = "download-link";
    body.appendChild(img);
  } else if (payload.type === "audio" && payload.audioData) {
    body.textContent = "";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = payload.audioData;
    body.appendChild(audio);
  } else if (payload.type === "file" && payload.fileData) {
    body.textContent = payload.name || "File";
    const meta = document.createElement("div");
    meta.style.fontSize = "0.75rem";
    meta.style.opacity = "0.8";
    meta.textContent = payload.mime || "Unknown file";
    body.appendChild(meta);
  } else {
    body.textContent = payload.text || "";
    if (from === "me" && payload.type === "text") {
      messageBodies.set(payload.id, payload.text || "");
    }
  }

  bubble.appendChild(small);
  bubble.appendChild(body);
  const time = document.createElement("div");
  time.className = "timestamp";
  time.dataset.originalTime =
    payload.time ||
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (payload.edited) {
    time.textContent = `edited ${time.dataset.originalTime}`;
  } else {
    time.textContent = time.dataset.originalTime;
  }
  bubble.appendChild(time);

  if (payload.uploading) {
    const uploading = document.createElement("div");
    uploading.className = "uploading";
    uploading.textContent = "Uploading…";
    uploading.dataset.uploadingFor = payload.id;
    bubble.appendChild(uploading);
  } else {
    const existing = document.querySelector(
      `.uploading[data-uploading-for="${payload.id}"]`
    );
    if (existing) existing.remove();
  }

  const reactionsRow = document.createElement("div");
  reactionsRow.className = "reactions";
  const menu = document.createElement("div");
  menu.className = "react-menu";
  const menuActions = document.createElement("div");
  menuActions.className = "react-actions";
  const menuEmojis = document.createElement("div");
  menuEmojis.className = "react-emojis";

  REACTION_EMOJIS.forEach((emoji) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "react-option";
    opt.textContent = emoji;
    opt.dataset.emoji = emoji;
    menuEmojis.appendChild(opt);
  });

  if (payload.type === "image" && payload.imageData) {
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "edit-btn";
    downloadBtn.textContent = "⬇";
    downloadBtn.dataset.download = payload.imageData;
    downloadBtn.dataset.filename = payload.name || "image";
    menuActions.appendChild(downloadBtn);
  }
  if (payload.type === "audio" && payload.audioData) {
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "edit-btn";
    downloadBtn.textContent = "⬇";
    downloadBtn.dataset.download = payload.audioData;
    downloadBtn.dataset.filename = payload.name || "voice-message.webm";
    menuActions.appendChild(downloadBtn);
  }
  if (payload.type === "file" && payload.fileData) {
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "edit-btn";
    downloadBtn.textContent = "⬇";
    downloadBtn.dataset.download = payload.fileData;
    downloadBtn.dataset.filename = payload.name || "file";
    menuActions.appendChild(downloadBtn);
  }
  if (from === "me") {
    if (payload.type === "text") {
      const editOpt = document.createElement("button");
      editOpt.type = "button";
      editOpt.className = "edit-btn";
      editOpt.textContent = "✏️";
      editOpt.title = "Edit";
      editOpt.dataset.mid = payload.id;
      menuActions.appendChild(editOpt);
    }
    const deleteOpt = document.createElement("button");
    deleteOpt.type = "button";
    deleteOpt.className = "delete-btn";
    deleteOpt.textContent = "🗑️";
    deleteOpt.title = "Delete";
    deleteOpt.dataset.mid = payload.id;
    menuActions.appendChild(deleteOpt);
  }

  menu.appendChild(menuActions);
  menu.appendChild(menuEmojis);
  const reactionPills = document.createElement("div");
  reactionPills.className = "reaction-pills";
  reactionsRow.appendChild(reactionPills);
  reactionsRow.appendChild(menu);
  reactionsRow.style.display = "flex";
  bubble.appendChild(reactionsRow);
  msg.appendChild(bubble);

  attachReactionMenu(reactionsRow);

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (from === "peer") {
    setTypingIndicator(false);
  }

  if (!messageReactions.has(payload.id)) {
    messageReactions.set(payload.id, new Map());
  }

  renderReactions(payload.id);
}

async function sendPayload(payload) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    log("Channel not open.");
    return false;
  }
  if (!sharedKey) {
    log("Missing key.");
    return false;
  }

  if (!payload.id) {
    payload.id = crypto.randomUUID();
  }

  if (
    !payload.time &&
    payload.type !== "reaction" &&
    payload.type !== "typing"
  ) {
    payload.time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const isUpload =
    payload.type === "image" ||
    payload.type === "audio" ||
    payload.type === "file";
  if (isUpload) {
    appendChatMessage("me", { ...payload, uploading: true });
  }

  const serialized = JSON.stringify(payload);

  if (serialized.length <= CHUNK_SIZE) {
    const encrypted = await encryptMessage(sharedKey, serialized);
    await sendEncrypted(encrypted);
  } else {
    const id = crypto.randomUUID();
    for (let i = 0; i < serialized.length; i += CHUNK_SIZE) {
      const slice = serialized.slice(i, i + CHUNK_SIZE);
      const chunk = {
        type: "chunk",
        id,
        payloadType: payload.type,
        data: slice,
        final: i + CHUNK_SIZE >= serialized.length,
      };
      const encryptedChunk = await encryptMessage(
        sharedKey,
        JSON.stringify(chunk)
      );
      await sendEncrypted(encryptedChunk);
    }
  }
  return true;
}

async function sendEncrypted(data) {
  if (!dataChannel) return;
  if (dataChannel.bufferedAmountLowThreshold < 65536) {
    dataChannel.bufferedAmountLowThreshold = 65536;
  }
  dataChannel.send(data);
  if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
    await new Promise((resolve) => {
      const handler = () => {
        dataChannel.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      dataChannel.addEventListener("bufferedamountlow", handler);
    });
  }
}

function handleIncomingPayload(serialized) {
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    payload = { type: "text", text: serialized };
  }

  if (!payload || !payload.type) {
    payload = { type: "text", text: serialized };
  }

  if (payload.type === "chunk" && payload.id) {
    const existing = pendingChunks.get(payload.id) || { data: "" };
    existing.data += payload.data || "";
    pendingChunks.set(payload.id, existing);

    if (payload.final) {
      try {
        const fullPayload = JSON.parse(existing.data);
        pendingChunks.delete(payload.id);
        appendChatMessage("peer", fullPayload);
      } catch (e) {
        log("Chunk assemble error: " + e);
        pendingChunks.delete(payload.id);
      }
    }
    return;
  }

  if (payload.type === "typing") {
    setTypingIndicator(!!payload.active);
    return;
  }

  if (payload.type === "reaction" && payload.target && payload.emoji) {
    applyReaction(payload.target, payload.emoji, payload.from, payload.action);
    return;
  }

  if (payload.type === "delete" && payload.target) {
    applyDelete(payload.target);
    return;
  }

  if (
    payload.type === "edit" &&
    payload.target &&
    typeof payload.text === "string"
  ) {
    applyEdit(payload.target, payload.text, payload.time, payload.edited);
    return;
  }

  appendChatMessage("peer", payload);
  setTypingIndicator(false);

  if (payload.uploading) {
    // ignore intermediate uploading markers from peer
    return;
  }

  const pendingUpload = document.querySelector(
    `.uploading[data-uploading-for="${payload.id}"]`
  );
  if (pendingUpload) pendingUpload.remove();
}

async function requestMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micAllowed = true;
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    micAllowed = false;
    log("Mic permission denied or unavailable.");
    return false;
  }
}

function sendTypingStatus(active) {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  if (lastTypingState === active) {
    if (active && typingTimeout) {
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => sendTypingStatus(false), 2000);
    }
    return;
  }

  lastTypingState = active;
  typingTimeout && clearTimeout(typingTimeout);

  sendPayload({ type: "typing", active });

  if (active) {
    typingTimeout = setTimeout(() => sendTypingStatus(false), 2000);
  }
}

function applyReaction(targetId, emoji, actor, action = "toggle") {
  if (!targetId || !emoji || !actor) return;
  const map = messageReactions.get(targetId) || new Map();
  const state = map.get(emoji) || { host: false, guest: false };
  if (action === "toggle") {
    state[actor] = !state[actor];
  } else if (action === "add") {
    state[actor] = true;
  } else if (action === "remove") {
    state[actor] = false;
  }

  if (!state.host && !state.guest) {
    map.delete(emoji);
  } else {
    map.set(emoji, state);
  }

  if (map.size === 0) {
    messageReactions.delete(targetId);
  } else {
    messageReactions.set(targetId, map);
  }

  renderReactions(targetId);
}

function renderReactions(targetId) {
  const msg = chatMessages.querySelector(`[data-mid="${targetId}"]`);
  if (!msg) return;
  const pillsContainer = msg.querySelector(".reaction-pills");
  if (!pillsContainer) return;
  const reactionsRow = msg.querySelector(".reactions");
  if (!reactionsRow) return;
  pillsContainer.innerHTML = "";

  const map = messageReactions.get(targetId);
  if (!map || map.size === 0) {
    pillsContainer.style.display = "none";
    reactionsRow.classList.remove("has-reactions");
    reactionsRow.style.display = "flex";
    return;
  }

  pillsContainer.style.display = "flex";
  reactionsRow.style.display = "flex";
  reactionsRow.classList.add("has-reactions");

  for (const [emo, state] of map.entries()) {
    const count = (state.host ? 1 : 0) + (state.guest ? 1 : 0);
    if (count === 0) continue;
    const pill = document.createElement("span");
    pill.className = "reaction-pill";
    if (state.host) pill.classList.add("host-reacted");
    if (state.guest) pill.classList.add("guest-reacted");
    pill.dataset.emoji = emo;
    pill.dataset.target = targetId;
    pill.textContent = `${emo} ${count}`;
    pillsContainer.appendChild(pill);
  }
}

function applyEdit(targetId, newText, newTime, editedFlag = true) {
  const msg = chatMessages.querySelector(`[data-mid="${targetId}"]`);
  if (!msg) return;
  const body = msg.querySelector(".msg-body");
  if (body) {
    body.textContent = newText;
    messageBodies.set(targetId, newText);
  }
  const timeEl = msg.querySelector(".timestamp");
  if (timeEl) {
    const t =
      newTime ||
      timeEl.dataset.originalTime ||
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    timeEl.dataset.originalTime = t;
    timeEl.textContent = editedFlag ? `edited ${t}` : t;
  }
}

function applyDelete(targetId) {
  const msg = chatMessages.querySelector(`[data-mid="${targetId}"]`);
  if (msg) msg.remove();
  messageReactions.delete(targetId);
  messageBodies.delete(targetId);
}

/* ============================================
   HOST FLOW
============================================ */
document
  .getElementById("btnCreateOffer")
  .addEventListener("click", async () => {
    try {
      resetState();
      updateModeUI();
      isHost = true;

      log("Creating offer...");
      createPeerConnection();

      sharedKey = await generateSharedKey();
      log("Shared AES key generated.");

      if (mediaCheckbox.checked) {
        await getLocalMedia();
      } else {
        log("No media (chat-only mode).");
      }

      dataChannel = pc.createDataChannel("chat");
      setupDataChannelHandlers();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete();

      const blob = {
        v: 1,
        r: "h",
        t: "offer",
        s: pc.localDescription,
        k: await exportKeyBase64(sharedKey),
      };

      offerOut.value = btoa(JSON.stringify(blob));
      log("Offer ready. Send to guest.");
    } catch (e) {
      log("Offer error: " + e);
    }
  });

/* ============================================
   GUEST FLOW
============================================ */
document
  .getElementById("btnAcceptOffer")
  .addEventListener("click", async () => {
    try {
      const b64 = offerIn.value.trim();
      if (!b64) return log("No offer provided.");

      resetState();
      updateModeUI();
      isHost = false;

      log("Accepting offer...");
      const blob = JSON.parse(atob(b64));

      if (!blob || !blob.s || !blob.k) {
        return log("Invalid offer blob.");
      }

      createPeerConnection();

      sharedKey = await importKeyBase64(blob.k);
      log("Shared key imported.");

      await pc.setRemoteDescription(blob.s);

      if (mediaCheckbox.checked) {
        await getLocalMedia();
      } else {
        log("No media (chat-only mode).");
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete();

      const ansBlob = {
        v: 1,
        r: "g",
        t: "answer",
        s: pc.localDescription,
      };

      answerOut.value = btoa(JSON.stringify(ansBlob));
      log("Answer ready. Send to host.");
    } catch (e) {
      log("Accept error: " + e);
    }
  });

document
  .getElementById("btnApplyAnswer")
  .addEventListener("click", async () => {
    try {
      const b64 = answerIn.value.trim();
      if (!b64) return log("No answer provided.");

      log("Applying answer...");
      const blob = JSON.parse(atob(b64));

      if (!blob || !blob.s) {
        return log("Invalid answer blob.");
      }

      await pc.setRemoteDescription(blob.s);
      log("Answer applied.");
    } catch (e) {
      log("Apply answer error: " + e);
    }
  });

/* ============================================
   Copy Buttons
============================================ */
document.getElementById("btnCopyOffer").addEventListener("click", () => {
  if (!offerOut.value.trim()) return;
  navigator.clipboard.writeText(offerOut.value.trim());
});
document.getElementById("btnCopyAnswerGuest").addEventListener("click", () => {
  if (!answerOut.value.trim()) return;
  navigator.clipboard.writeText(answerOut.value.trim());
});

/* ============================================
   Chat Send
============================================ */
btnSend.addEventListener("click", async () => {
  const text = chatInput.value.trim();
  if (!text) return;

  const payload = { type: "text", text };
  const sent = await sendPayload(payload);
  if (sent) {
    appendChatMessage("me", payload);
    chatInput.value = "";
  }
  sendTypingStatus(false);
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("btnSend").click();
  }
  sendTypingStatus(true);
});
chatInput.addEventListener("input", () => {
  sendTypingStatus(true);
});
chatInput.addEventListener("blur", () => {
  sendTypingStatus(false);
});

emojiSelect.addEventListener("change", () => {
  const emoji = emojiSelect.value;
  if (!emoji) return;
  const ready = dataChannel && dataChannel.readyState === "open" && sharedKey;
  if (ready && !chatInput.value.trim()) {
    const payload = { type: "text", text: emoji };
    sendPayload(payload).then((sent) => {
      if (sent) appendChatMessage("me", payload);
    });
  } else {
    chatInput.value += emoji;
    chatInput.focus();
    sendTypingStatus(true);
  }
  emojiSelect.selectedIndex = 0;
});

btnPhoto.addEventListener("click", () => {
  photoInput.click();
});

photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    if (typeof dataUrl !== "string") return;

    let payload;
    if (file.type && file.type.startsWith("image/")) {
      payload = { type: "image", imageData: dataUrl, name: file.name };
    } else if (file.type && file.type.startsWith("audio/")) {
      payload = { type: "audio", audioData: dataUrl, name: file.name };
    } else {
      payload = {
        type: "file",
        fileData: dataUrl,
        name: file.name,
        mime: file.type || "file",
      };
    }

    const sent = await sendPayload(payload);
    if (sent) {
      appendChatMessage("me", payload);
    }
    photoInput.value = "";
  };
  reader.readAsDataURL(file);
});

btnRecord.addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    btnRecord.textContent = "🎤";
    return;
  }

  if (!micAllowed) {
    micRequested = true;
    btnRecord.disabled = true;
    const granted = await requestMicPermission();
    btnRecord.disabled = false;
    updateSendControls();
    if (!granted) {
      return;
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      const reader = new FileReader();
      reader.onload = async () => {
        const audioData = reader.result;
        if (typeof audioData !== "string") return;

        const payload = {
          type: "audio",
          audioData,
          name: `voice-${Date.now()}.webm`,
        };
        const sent = await sendPayload(payload);
        if (sent) {
          appendChatMessage("me", payload);
        }
      };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start();
    btnRecord.textContent = "⏹";
  } catch (e) {
    log("Mic access error: " + e);
    btnRecord.textContent = "🎤";
  }
});

function handleReactionSelection(target) {
  const emoji = target.dataset.emoji;
  const msg = target.closest(".msg");
  const id = msg?.dataset.mid;
  if (!emoji || !id) return;
  const actor = getActorRole();
  const payload = {
    type: "reaction",
    target: id,
    emoji,
    from: actor,
    action: "toggle",
  };
  sendPayload(payload).then((sent) => {
    if (sent) applyReaction(id, emoji, actor, "toggle");
  });
  closeReactionMenus();
}

chatMessages.addEventListener("pointerdown", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains("reaction-pill")) {
    const actor = getActorRole();
    const emoji = target.dataset.emoji;
    const id = target.dataset.target;
    if (!emoji || !id) return;
    const map = messageReactions.get(id);
    const state = map?.get(emoji);
    const reacted = actor === "host" ? state?.host : state?.guest;
    if (reacted) {
      const payload = {
        type: "reaction",
        target: id,
        emoji,
        from: actor,
        action: "remove",
      };
      sendPayload(payload).then((sent) => {
        if (sent) applyReaction(id, emoji, actor, "remove");
      });
    }
    return;
  }
  if (target.dataset.download) {
    const data = target.dataset.download;
    const name = target.dataset.filename || "file";
    const a = document.createElement("a");
    a.href = data;
    a.download = name;
    a.click();
    closeReactionMenus();
    return;
  }
  if (target.classList.contains("react-option")) {
    e.preventDefault();
    handleReactionSelection(target);
    closeReactionMenus();
    return;
  }
  if (target.classList.contains("edit-btn")) {
    const id = target.dataset.mid;
    if (!id) return;
    const current = messageBodies.get(id) || "";
    const next = prompt("Edit message", current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const payload = {
      type: "edit",
      target: id,
      text: trimmed,
      edited: true,
      time,
    };
    sendPayload(payload).then((sent) => {
      if (sent) applyEdit(id, trimmed, time, true);
    });
    closeReactionMenus();
    return;
  }
  if (target.classList.contains("delete-btn")) {
    const id = target.dataset.mid;
    if (!id) return;
    const confirmDelete = confirm("Delete this message?");
    if (!confirmDelete) return;
    const payload = { type: "delete", target: id };
    sendPayload(payload).then((sent) => {
      if (sent) applyDelete(id);
    });
    closeReactionMenus();
    return;
  }
});

/* ============================================
   Reset Button
============================================ */
document.getElementById("btnReset").addEventListener("click", resetState);

/* ============================================
   Initialize UI
============================================ */
resetState();
updateVideoUI();
updateModeUI();

window.addEventListener("beforeunload", () => {
  if (pc) pc.close();
  if (dataChannel) dataChannel.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
});
