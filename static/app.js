// PaperLens frontend. No frameworks.
//
// Streaming design note: EventSource only supports GET with no body, and we
// need to POST a question. So we use fetch() and parse the SSE wire format
// off the response body stream ourselves — same protocol, full control.
//
// Multi-chat design note: the backend is deliberately stateless across
// restarts and holds ONE document index in process memory. All persistence
// lives in the browser: chat metadata + message history in localStorage
// (small JSON), PDF bytes in IndexedDB (Blobs; localStorage is string-only
// and too small for binary). Resuming a chat re-POSTs its stored PDF to
// /api/upload to rebuild the server's in-memory index — "re-index on resume".

"use strict";

const dropZone = document.getElementById("drop-zone");
const pdfInput = document.getElementById("pdf-input");
const uploadLabel = document.getElementById("upload-label");
const uploadStatus = document.getElementById("upload-status");
const chatPanel = document.getElementById("chat-panel");
const messagesEl = document.getElementById("messages");
const askForm = document.getElementById("ask-form");
const questionEl = document.getElementById("question");
const askBtn = document.getElementById("ask-btn");
const chatListEl = document.getElementById("chat-list");
const sidebarEmptyEl = document.getElementById("sidebar-empty");
const newChatBtn = document.getElementById("new-chat-btn");
const sidebarToggle = document.getElementById("sidebar-toggle");
const scrim = document.getElementById("scrim");
const starterEl = document.getElementById("starter");
const librarySearch = document.getElementById("library-search");
const searchInput = document.getElementById("search-input");
const searchEmptyEl = document.getElementById("search-empty");
const dragOverlay = document.getElementById("drag-overlay");

let chatFilter = "";

starterEl.querySelectorAll(".starter-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (!askReady) return;
    questionEl.value = chip.textContent;
    askForm.requestSubmit();
  });
});

// Show starters only when the active chat is ready and has no messages yet.
function updateStarter() {
  starterEl.hidden = !(askReady && messagesEl.childElementCount === 0);
}

const UPLOAD_HINT = "or click to browse · up to 20 MB";

// ---------- Chat store (localStorage: metadata + messages) ----------

const STORE_KEY = "paperlens.chats.v1";

function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chats));
  } catch (err) {
    console.warn("Could not persist chats (storage full?):", err);
  }
}

let chats = loadChats();
let activeChatId = null; // chat shown in the main panel
let indexedChatId = null; // chat whose PDF the backend currently has indexed
let askReady = false; // guard: only true when active chat's PDF is indexed

const getChat = (id) => chats.find((c) => c.id === id);

// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
// The Elastic Beanstalk deploy is plain HTTP, where it's undefined — so fall
// back to a manual RFC-4122 v4 generator (crypto.getRandomValues is available
// on HTTP too; Math.random is the last resort).
function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// ---------- PDF store (IndexedDB: binary blobs, keyed by chat id) ----------

const idb = (() => {
  let dbPromise = null;
  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("paperlens", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pdfs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function run(mode, op) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = op(db.transaction("pdfs", mode).objectStore("pdfs"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return {
    put: (id, value) => run("readwrite", (s) => s.put(value, id)),
    get: (id) => run("readonly", (s) => s.get(id)),
    del: (id) => run("readwrite", (s) => s.delete(id)),
  };
})();

// ---------- Sidebar ----------

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  "</svg>";

const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/>' +
  '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
  "</svg>";

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderSidebar() {
  chatListEl.replaceChildren();
  sidebarEmptyEl.hidden = chats.length > 0;
  librarySearch.hidden = chats.length === 0;

  const q = chatFilter.trim().toLowerCase();
  const visible = q
    ? chats.filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          (c.filename || "").toLowerCase().includes(q)
      )
    : chats;

  searchEmptyEl.hidden = !(chats.length > 0 && visible.length === 0);

  for (const chat of visible) {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");
    item.addEventListener("click", () => openChat(chat.id));

    const main = document.createElement("div");
    main.className = "chat-item-main";
    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = chat.title || "New Chat";
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = `${chat.filename} · ${relTime(chat.updatedAt)}`;
    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "chat-actions";

    const edit = document.createElement("button");
    edit.className = "chat-action chat-edit";
    edit.setAttribute("aria-label", `Rename chat: ${chat.title || "New Chat"}`);
    edit.innerHTML = PENCIL_SVG; // constant markup only — never user data
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      beginRename(chat, main, title);
    });

    const del = document.createElement("button");
    del.className = "chat-action chat-delete";
    del.setAttribute("aria-label", `Delete chat: ${chat.title || "New Chat"}`);
    del.innerHTML = TRASH_SVG; // constant markup only — never user data
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    actions.append(edit, del);
    item.append(main, actions);
    chatListEl.appendChild(item);
  }
}

// Inline rename: swap the title into a text input, commit on Enter/blur.
function beginRename(chat, mainEl, titleEl) {
  const input = document.createElement("input");
  input.className = "chat-rename";
  input.value = chat.title || "";
  input.maxLength = 120;
  input.setAttribute("aria-label", "Chat title");
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) {
        chat.title = v;
        chat.updatedAt = Date.now();
        saveChats();
      }
    }
    renderSidebar();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

searchInput.addEventListener("input", () => {
  chatFilter = searchInput.value;
  renderSidebar();
});

function setSidebarOpen(open) {
  document.body.classList.toggle("sidebar-open", open);
  scrim.hidden = !open;
  sidebarToggle.setAttribute("aria-expanded", String(open));
}

sidebarToggle.addEventListener("click", () =>
  setSidebarOpen(!document.body.classList.contains("sidebar-open"))
);
scrim.addEventListener("click", () => setSidebarOpen(false));

// ---------- Chat lifecycle ----------

newChatBtn.addEventListener("click", startNewChat);

function startNewChat() {
  activeChatId = null;
  messagesEl.replaceChildren();
  chatPanel.hidden = true;
  dropZone.classList.remove("done", "error", "restoring");
  uploadLabel.textContent = "Drop your PDF here";
  uploadStatus.textContent = UPLOAD_HINT;
  setAskEnabled(false);
  renderSidebar();
  setSidebarOpen(false);
}

async function openChat(id) {
  if (id === activeChatId && id === indexedChatId) {
    setSidebarOpen(false);
    return;
  }
  const chat = getChat(id);
  if (!chat) return;

  activeChatId = id;
  renderSidebar();
  setSidebarOpen(false);
  renderHistory(chat);
  chatPanel.hidden = false;
  setAskEnabled(false);

  // The backend indexes one document at a time, so resuming a chat means
  // rebuilding the index from the PDF bytes we kept in IndexedDB.
  if (indexedChatId === id) {
    showFileChip(chat);
    setAskEnabled(true);
    questionEl.focus();
    return;
  }

  dropZone.classList.remove("done", "error");
  dropZone.classList.add("restoring");
  uploadLabel.textContent = "Restoring document…";
  uploadStatus.textContent = chat.filename;

  try {
    const rec = await idb.get(id);
    if (activeChatId !== id) return; // user switched away mid-restore
    if (!rec || !rec.blob) {
      throw new Error("Stored PDF not found — re-upload it to continue.");
    }
    const form = new FormData();
    form.append("file", new File([rec.blob], chat.filename, { type: "application/pdf" }));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const body = await res.json();
    if (activeChatId !== id) return;
    if (!res.ok) throw new Error(body.detail || "Re-indexing failed.");

    indexedChatId = id;
    dropZone.classList.remove("restoring");
    showFileChip(chat);
    setAskEnabled(true);
    questionEl.focus();
  } catch (err) {
    if (activeChatId !== id) return;
    dropZone.classList.remove("restoring");
    dropZone.classList.add("error");
    uploadLabel.textContent = chat.filename;
    uploadStatus.textContent = err.message || "Could not restore this document.";
  }
}

function showFileChip(chat) {
  dropZone.classList.remove("error", "restoring");
  dropZone.classList.add("done");
  uploadLabel.textContent = chat.filename;
  uploadStatus.textContent = `${chat.pages} pages · indexed & ready`;
}

function deleteChat(id) {
  const chat = getChat(id);
  if (!chat) return;
  if (!confirm(`Delete "${chat.title || "New Chat"}"? This cannot be undone.`)) return;

  chats = chats.filter((c) => c.id !== id);
  saveChats();
  idb.del(id).catch((err) => console.warn("IndexedDB delete failed:", err));
  if (indexedChatId === id) indexedChatId = null;
  if (activeChatId === id) startNewChat();
  else renderSidebar();
}

function renderHistory(chat) {
  messagesEl.replaceChildren();
  for (const msg of chat.messages) {
    addMessage("user").textContent = msg.q;
    const assistant = addMessage("assistant");
    const answerEl = document.createElement("div");
    answerEl.className = "answer";
    renderAnswer(answerEl, msg.a);
    assistant.appendChild(answerEl);
    if (msg.sources && msg.sources.length) {
      assistant.appendChild(renderSources(msg.sources));
    }
    addActions(assistant, msg.a);
  }
}

// ---------- Upload (always starts a new chat) ----------

pdfInput.addEventListener("change", () => {
  if (pdfInput.files.length) uploadPdf(pdfInput.files[0]);
});

["dragover", "dragleave", "drop"].forEach((type) => {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.toggle("dragover", type === "dragover");
    if (type === "drop") {
      e.stopPropagation(); // handled here — don't also fire the window drop
      dragDepth = 0;
      dragOverlay.hidden = true;
      if (e.dataTransfer.files.length) uploadPdf(e.dataTransfer.files[0]);
    }
  });
});

// Drag a PDF anywhere in the window — full-screen drop target.
let dragDepth = 0;
const hasFiles = (e) =>
  e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dragOverlay.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOverlay.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragOverlay.hidden = true;
  if (e.dataTransfer.files.length) uploadPdf(e.dataTransfer.files[0]);
});

// Reject oversized PDFs client-side before they ever reach /api/upload.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

async function uploadPdf(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    dropZone.classList.remove("done", "restoring");
    dropZone.classList.add("error");
    uploadLabel.textContent = "Drop your PDF here";
    uploadStatus.textContent =
      "This PDF is too large for the demo (max 20 MB). Please try a smaller document.";
    return;
  }

  dropZone.classList.remove("error", "done", "restoring");
  uploadLabel.textContent = "Indexing…";
  uploadStatus.textContent = `Reading ${file.name}`;
  setAskEnabled(false);

  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Upload failed.");

    // Every successful upload begins a fresh chat.
    const chat = {
      id: makeId(),
      title: null, // becomes the first question
      filename: file.name,
      pages: body.pages,
      chunks: body.chunks,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    chats.unshift(chat);
    activeChatId = chat.id;
    indexedChatId = chat.id;
    saveChats();

    try {
      await idb.put(chat.id, { blob: file, filename: file.name, savedAt: Date.now() });
    } catch (err) {
      // Chat still works this session; only resume-after-reload is lost.
      console.warn("Could not store PDF in IndexedDB:", err);
    }

    showFileChip(chat);
    renderSidebar();
    chatPanel.hidden = false;
    messagesEl.replaceChildren();
    setAskEnabled(true);
    questionEl.focus();
  } catch (err) {
    dropZone.classList.add("error");
    uploadLabel.textContent = "Drop your PDF here";
    uploadStatus.textContent = err.message;
  }
}

// ---------- Ask ----------

function setAskEnabled(on) {
  askReady = on;
  if (!askBtn.classList.contains("loading")) {
    questionEl.disabled = !on;
    askBtn.disabled = !on;
  }
  askForm.classList.toggle("disabled", !on);
  questionEl.placeholder = on
    ? "Ask another question…"
    : "Upload a PDF to start asking…";
  updateStarter();
}

function setLoading(on) {
  askBtn.classList.toggle("loading", on);
  askBtn.disabled = on || !askReady;
  questionEl.disabled = on || !askReady;
}

askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!askReady) return;
  const question = questionEl.value.trim();
  if (!question) return;
  questionEl.value = "";
  addMessage("user").textContent = question;
  renderAssistantTurn(question, activeChatId);
});

// Runs one assistant turn: streams the answer, persists it, and wires the
// copy/retry actions. Extracted so a failed turn's "Try again" can re-run it.
async function renderAssistantTurn(question, chatId) {
  setLoading(true);
  const assistant = addMessage("assistant");
  const answerEl = document.createElement("div");
  answerEl.className = "answer";
  answerEl.appendChild(makeThinking()); // pulsing dots until the first token
  assistant.appendChild(answerEl);

  try {
    await streamAnswer(question, assistant, answerEl);
    // Persist the completed turn to the chat that asked it.
    const chat = getChat(chatId);
    if (chat && answerEl._raw) {
      chat.messages.push({
        q: question,
        a: answerEl._raw,
        sources: assistant._sources || [],
      });
      if (!chat.title) chat.title = question;
      chat.updatedAt = Date.now();
      saveChats();
      renderSidebar();
    }
    if (answerEl._raw) addActions(assistant, answerEl._raw);
  } catch (err) {
    removeThinking(assistant);
    const errEl = document.createElement("div");
    errEl.className = "error-text";
    errEl.textContent = err.message || "Request failed.";
    assistant.appendChild(errEl);
    addRetry(assistant, question, chatId);
  } finally {
    assistant.classList.remove("streaming");
    setLoading(false);
    if (askReady) questionEl.focus();
  }
}

const COPY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const RETRY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
  'stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/>' +
  '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

// Copy-answer control, shown under a completed answer.
function addActions(assistantEl, rawText) {
  if (assistantEl.querySelector(".msg-actions")) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg-action";
  copy.innerHTML = COPY_SVG + "<span>Copy</span>";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      copy.classList.add("done");
      copy.innerHTML = CHECK_SVG + "<span>Copied</span>";
      setTimeout(() => {
        copy.classList.remove("done");
        copy.innerHTML = COPY_SVG + "<span>Copy</span>";
      }, 1600);
    } catch {
      copy.querySelector("span").textContent = "Press ⌘C";
    }
  });

  bar.appendChild(copy);
  assistantEl.appendChild(bar);
}

// Try-again control, shown when a turn errors out.
function addRetry(assistantEl, question, chatId) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "msg-action";
  retry.innerHTML = RETRY_SVG + "<span>Try again</span>";
  retry.addEventListener("click", () => {
    if (!askReady) return;
    assistantEl.remove();
    renderAssistantTurn(question, chatId);
  });
  bar.appendChild(retry);
  assistantEl.appendChild(bar);
}

function addMessage(role) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  messagesEl.appendChild(el);
  updateStarter();
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

function makeThinking() {
  const wrap = document.createElement("div");
  wrap.className = "thinking";
  for (let i = 0; i < 3; i++) wrap.appendChild(document.createElement("span"));
  return wrap;
}

function removeThinking(assistantEl) {
  const t = assistantEl.querySelector(".thinking");
  if (t) t.remove();
}

// ===== fetch + SSE parsing =====

async function streamAnswer(question, assistantEl, answerEl) {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; keep the trailing partial
    // frame in the buffer until the rest of it arrives.
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (event) handleEvent(event, assistantEl, answerEl);
    }
  }
}

function parseFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

// ===== event painting =====

function handleEvent({ event, data }, assistantEl, answerEl) {
  if (event === "token") {
    if (answerEl._raw === undefined) {
      // First token: drop the thinking dots, switch on the blinking cursor.
      answerEl._raw = "";
      answerEl.replaceChildren();
      assistantEl.classList.add("streaming");
    }
    answerEl._raw += data.text;
    renderAnswer(answerEl, answerEl._raw);
    answerEl.scrollIntoView({ block: "end" });
  } else if (event === "sources") {
    // Sources arrive before the answer; appended after answerEl so they
    // render as a collapsible below the response. Stashed for persistence.
    assistantEl._sources = data.sources;
    assistantEl.appendChild(renderSources(data.sources));
  } else if (event === "error") {
    removeThinking(assistantEl);
    const errEl = document.createElement("div");
    errEl.className = "error-text";
    errEl.textContent = data.message;
    assistantEl.appendChild(errEl);
  }
}

// ---------- Markdown answer rendering ----------
//
// The model answers in Markdown (bold, bullets, nesting) AND emits inline
// citations like [1][2]. Those two collide: "[1][2]" is valid Markdown
// reference-link syntax, so handing the raw text to a parser can turn
// citations into <a> tags or drop them. So citations never meet the parser:
//
//   1. swap every [n] for an opaque random token (Markdown ignores it)
//   2. parse Markdown -> HTML
//   3. sanitize that HTML through a strict allowlist (model output is untrusted)
//   4. walk the sanitized DOM's *text nodes* and swap tokens for <span.cite>
//      elements built with createElement — pills never travel as HTML strings
//
// Rebuilt from the full accumulated text on each token, so a marker or a
// bold-run split across two tokens resolves once complete.

const CITE = /\[(\d+)\]/g;

// Random per page load so document text can't collide with the placeholder.
const CITE_TOKEN = "plcite" + Math.random().toString(36).slice(2, 10);
const CITE_TOKEN_RE = new RegExp(CITE_TOKEN + "(\\d+)" + CITE_TOKEN, "g");

const protectCitations = (text) =>
  text.replace(CITE, (_m, n) => `${CITE_TOKEN}${n}${CITE_TOKEN}`);

// Strict allowlist. Anything not listed is unwrapped (children kept) or, for
// the tags below, dropped outright along with its subtree.
const ALLOWED_TAGS = {
  P: [], BR: [], HR: [], STRONG: [], B: [], EM: [], I: [], S: [], DEL: [],
  CODE: [], PRE: [], BLOCKQUOTE: [], UL: [], OL: ["start"], LI: [],
  H1: [], H2: [], H3: [], H4: [], H5: [], H6: [],
  TABLE: [], THEAD: [], TBODY: [], TR: [], TH: [], TD: [],
  A: ["href", "title"],
};
const DROP_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT",
  "TEXTAREA", "BUTTON", "SELECT", "LINK", "META", "SVG", "MATH", "BASE",
]);

function safeHref(value) {
  try {
    const url = new URL(value, document.baseURI);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Rebuild the parsed HTML into a fresh fragment, copying only allowed nodes.
function sanitizeNode(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (DROP_TAGS.has(child.tagName)) continue; // drop element + subtree

    const allowedAttrs = ALLOWED_TAGS[child.tagName];
    if (!allowedAttrs) {
      sanitizeNode(child, out); // unknown tag: unwrap, keep its content
      continue;
    }

    const el = document.createElement(child.tagName.toLowerCase());
    for (const name of allowedAttrs) {
      if (!child.hasAttribute(name)) continue;
      let value = child.getAttribute(name);
      if (name === "href") {
        value = safeHref(value);
        if (!value) continue; // strips javascript:/data: URLs
      }
      el.setAttribute(name, value);
    }
    if (el.tagName === "A" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    sanitizeNode(child, el);
    out.appendChild(el);
  }
}

function sanitizeToFragment(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const frag = document.createDocumentFragment();
  sanitizeNode(doc.body, frag);
  return frag;
}

// Swap placeholder tokens inside text nodes for real pill elements.
function restoreCitations(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.includes(CITE_TOKEN)) targets.push(n);
  }
  for (const textNode of targets) {
    const frag = document.createDocumentFragment();
    const text = textNode.nodeValue;
    let last = 0;
    let match;
    CITE_TOKEN_RE.lastIndex = 0;
    while ((match = CITE_TOKEN_RE.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const pill = document.createElement("span");
      pill.className = "cite";
      pill.textContent = match[1];
      frag.appendChild(pill);
      last = CITE_TOKEN_RE.lastIndex;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    textNode.replaceWith(frag);
  }
}

// Fallback when marked failed to load: plain text, newlines preserved by CSS.
function plainFragment(protectedText) {
  const frag = document.createDocumentFragment();
  const p = document.createElement("p");
  p.className = "md-plain";
  p.textContent = protectedText;
  frag.appendChild(p);
  return frag;
}

function renderAnswer(answerEl, text) {
  const protectedText = protectCitations(text);

  let frag = null;
  if (typeof marked !== "undefined" && typeof marked.parse === "function") {
    try {
      frag = sanitizeToFragment(marked.parse(protectedText, { gfm: true, breaks: true }));
    } catch (err) {
      console.warn("Markdown render failed; falling back to plain text:", err);
      frag = null;
    }
  }
  if (!frag || !frag.firstElementChild) frag = plainFragment(protectedText);

  restoreCitations(frag);
  answerEl.replaceChildren(frag);
}

function renderSources(sources) {
  const details = document.createElement("details");
  details.className = "sources";
  const summary = document.createElement("summary");
  summary.textContent = "Where this came from";
  details.appendChild(summary);

  for (const s of sources) {
    const row = document.createElement("div");
    row.className = "source";

    const meta = document.createElement("div");
    meta.className = "meta";
    const badge = document.createElement("span");
    badge.className = "page-badge";
    badge.textContent = `Page ${s.page}`;
    const score = document.createElement("span");
    score.className = "match";
    score.textContent = "Strong match";
    meta.append(badge, score);

    const snippet = document.createElement("div");
    snippet.className = "snippet";
    snippet.textContent = s.text;

    row.append(meta, snippet);
    details.appendChild(row);
  }
  return details;
}

// ---------- Boot ----------

setAskEnabled(false);
renderSidebar();
