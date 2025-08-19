import { CryptoAPI } from './crypto.js';
import { DB } from './db.js';
import { QR } from './qr.js';
import { openModal, closeModal } from './modal.js'; // <-- Import the new modal manager

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function uid(prefix='id') {
  return prefix + ':' + Math.random().toString(36).slice(2,10);
}

async function init() {
  // Theme init
  const theme = await localforage.getItem('theme') || 'light';
  applyTheme(theme === 'dark' ? 'dark' : 'light');

  setupListeners();
  await refreshNotesList();

  // Clipboard monitor state
  const clipState = await localforage.getItem('clipboardMonitor') || false;
  const clipboardMonitor = $('#clipboard-monitor');
  if (clipboardMonitor) clipboardMonitor.checked = clipState;
  if (clipState) startClipboardMonitor();

  // RSA banner
  await refreshRSAUI();
}

function applyTheme(mode) {
  if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localforage.setItem('theme', mode);
}

function setupListeners() {
  const listeners = [
    ['#theme-toggle', 'click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      applyTheme(dark ? 'light' : 'dark');
    }],
    ['#new-note-btn', 'click', newNote],
    ['#save-note-btn', 'click', saveNote],
    ['#delete-note-btn', 'click', deleteCurrentNote],
    ['#qr-share-btn', 'click', onShareQR],
    ['#export-note-btn', 'click', onExportNoteHTML],
    ['#open-mindmap', 'click', openMindMap],
    ['#open-timeline', 'click', openTimelineModal],
    ['#zen-toggle', 'click', () => {
      document.body.classList.toggle('zen');
      const el = document.getElementById('editor');
      if (el) {
        if (document.body.classList.contains('zen')) {
          el.requestFullscreen?.();
          el.classList.add('zen-mode');
        } else {
          document.exitFullscreen?.();
          el.classList.remove('zen-mode');
        }
      }
    }],
    ['#export-vault-btn', 'click', exportVault],
    ['#import-vault-btn', 'click', importVault],
    ['#clipboard-monitor', 'change', async (e) => {
      if (!e) return;
      // try to request permission gracefully
      const enabled = e.target.checked;
      if (enabled) {
        try {
          if (navigator.permissions && navigator.permissions.query) {
            const perm = await navigator.permissions.query({ name: 'clipboard-read' });
            if (perm.state === 'denied') {
              alert('Clipboard access denied by browser. Please allow clipboard access for clipboard monitor to work.');
              e.target.checked = false;
              await localforage.setItem('clipboardMonitor', false);
              return;
            }
          }
          await localforage.setItem('clipboardMonitor', true);
          startClipboardMonitor();
        } catch (err) {
          try {
            await navigator.clipboard.readText();
            await localforage.setItem('clipboardMonitor', true);
            startClipboardMonitor();
          } catch (err2) {
            alert('Clipboard monitor requires user permission. Please enable clipboard access or disable the monitor.');
            e.target.checked = false;
            await localforage.setItem('clipboardMonitor', false);
            return;
          }
        }
      } else {
        await localforage.setItem('clipboardMonitor', false);
        stopClipboardMonitor();
      }
    }],
    ['#search', 'input', refreshNotesList],
    // Key modal wiring
    ['#open-keys-btn', 'click', openKeysModal],
    ['#rsa-export-inline', 'click', onExportKeys]
  ];

  for (const [sel, evt, handler] of listeners) {
    const el = $(sel);
    if (el) el.addEventListener(evt, handler);
  }
}

// ----- Modal migration -----

function openKeysModal() {
  openModal(`
    <h3>RSA Key Management</h3>
    <p id="key-status">No RSA keys found.</p>
    <div class="key-actions" style="margin-bottom:1em">
      <button id="generate-keys-btn" class="btn primary">Generate New Keys</button>
      <button id="import-keys-btn" class="btn">Import Keys</button>
      <button id="export-keys-btn" class="btn">Export Keys</button>
      <button id="delete-keys-btn" class="btn danger">Delete Keys</button>
    </div>
  `);

  // Attach modal-specific listeners after rendering
  document.getElementById('generate-keys-btn')?.addEventListener('click', onGenerateKeys);
  document.getElementById('import-keys-btn')?.addEventListener('click', onImportKeys);
  document.getElementById('export-keys-btn')?.addEventListener('click', onExportKeys);
  document.getElementById('delete-keys-btn')?.addEventListener('click', onDeleteKeys);

  // Refresh banner/status inside modal
  refreshRSAUI();
}

function openTimelineModal() {
  openModal(`
    <div class="timeline-toolbar" style="margin-bottom:1em">
      <button class="close-btn btn">Close</button>
      <input id="timeline-range" type="range" min="1" max="100" value="50" title="Zoom (not implemented)" />
    </div>
    <div id="timeline" class="timeline"></div>
  `);
  document.querySelector('.close-btn')?.addEventListener('click', () => closeModal());
  const range = document.getElementById('timeline-range');
  if (range) range.addEventListener('input', onTimelineZoom);
  onTimelineZoom(); // Populate timeline
}

// Mindmap modal uses SVG, so just inject SVG and toolbar
async function openMindMap() {
  openModal(`
    <div class="mindmap-toolbar" style="margin-bottom:1em">
      <button class="close-btn btn">Close</button>
      <button id="mindmap-refresh" class="btn">Refresh</button>
    </div>
    <svg id="mindmap" width="100%" height="400"></svg>
  `);
  document.querySelector('.close-btn')?.addEventListener('click', () => closeModal());
  document.getElementById('mindmap-refresh')?.addEventListener('click', renderMindMap);
  await renderMindMap();
}

// QR modal
async function onShareQR() {
  if (!currentNoteId) {
    alert('Save a note first to share it.');
    return;
  }
  const note = await DB.getNote(currentNoteId);
  const payload = JSON.stringify({ meta: note.meta, content: note.content, title: note.title });
  const b64 = btoa(unescape(encodeURIComponent(payload)));
  openModal(`
    <h3>Share Note via QR Code</h3>
    <canvas id="qr-canvas"></canvas>
  `);
  const canvas = document.getElementById('qr-canvas');
  if (canvas) QR.renderToCanvas(b64, canvas, 4);
}

// ----- End modal migration -----

let clipboardInterval = null;
function startClipboardMonitor() {
  if (clipboardInterval) return;
  clipboardInterval = setInterval(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.length > 20) {
        const last = await localforage.getItem('savant:lastClip');
        if (last === text) return;
        await localforage.setItem('savant:lastClip', text);
        const id = uid('clip');
        const payload = {
          id,
          title: `Clipboard ${new Date().toLocaleString()}`,
          content: { plain: text },
          meta: { created: Date.now(), modified: Date.now(), tags: ['clipboard'] }
        };
        await DB.saveNote(payload);
        await refreshNotesList();
      }
    } catch (e) {
      stopClipboardMonitor();
      const clipboardMonitor = $('#clipboard-monitor');
      if (clipboardMonitor) clipboardMonitor.checked = false;
      localforage.setItem('clipboardMonitor', false);
      console.warn('Clipboard monitor stopped due to permission error or unsupported API.');
    }
  }, 5000);
}

function stopClipboardMonitor() {
  if (clipboardInterval) { clearInterval(clipboardInterval); clipboardInterval = null; }
}

let currentNoteId = null;

async function newNote() {
  const noteTitle = $('#note-title');
  const editor = $('#editor');
  const notePassphrase = $('#note-passphrase');
  const status = $('#status');
  if (noteTitle) noteTitle.value = '';
  if (editor) editor.value = '';
  if (notePassphrase) notePassphrase.value = '';
  currentNoteId = null;
  if (status) status.textContent = 'New note';
}

async function refreshNotesList() {
  const search = $('#search');
  const q = search ? search.value.trim().toLowerCase() : '';
  const notes = await DB.listNotes();
  const list = $('#notes-list');
  if (!list) return;
  list.innerHTML = '';
  for (const n of notes) {
    const title = n.title || '(untitled)';
    if (q && !(title.toLowerCase().includes(q) || (n.meta?.tags || []).join(' ').includes(q))) continue;
    const el = document.createElement('div');
    el.className = 'note-item';
    el.textContent = title;
    el.dataset.id = n.id;
    el.addEventListener('click', () => loadNote(n.id));
    list.appendChild(el);
  }
}

async function loadNote(id) {
  const n = await DB.getNote(id);
  if (!n) return;
  currentNoteId = id;
  const noteTitle = $('#note-title');
  const editor = $('#editor');
  const status = $('#status');
  if (n.content && (n.content.algo === 'AES-GCM' || n.content.algo === 'RSA-HYBRID')) {
    if (noteTitle) noteTitle.value = n.title;
    if (editor) editor.value = '[ENCRYPTED — enter passphrase (if used) or unlock manually then Save to decrypt]';
    if (status) status.textContent = `Encrypted (${n.content.algo})`;
  } else if (n.content && n.content.plain) {
    if (noteTitle) noteTitle.value = n.title;
    if (editor) editor.value = n.content.plain;
    if (status) status.textContent = 'Loaded (plain)';
  } else {
    if (noteTitle) noteTitle.value = n.title;
    if (editor) editor.value = '';
    if (status) status.textContent = 'Loaded';
  }
  renderNoteMeta(n);
}

function renderNoteMeta(n) {
  const meta = $('#note-meta');
  if (!meta) return;
  meta.innerHTML = `
    <div><strong>Title:</strong> ${n.title||'(untitled)'}</div>
    <div><strong>Created:</strong> ${new Date(n.meta.created).toLocaleString()}</div>
    <div><strong>Modified:</strong> ${new Date(n.meta.modified).toLocaleString()}</div>
    <div><strong>Tags:</strong> ${(n.meta.tags||[]).join(', ')}</div>
    <div><strong>Encryption:</strong> ${n.content?.algo || 'none'}</div>
  `;
}

async function saveNote() {
  const noteTitle = $('#note-title');
  const editor = $('#editor');
  const notePassphrase = $('#note-passphrase');
  const encryptionMode = $('#encryption-mode');
  const status = $('#status');
  if (!noteTitle || !editor || !encryptionMode) return;

  const title = noteTitle.value.trim() || 'Untitled';
  const contentText = editor.value;
  const passphrase = notePassphrase ? notePassphrase.value.trim() : '';
  const mode = encryptionMode.value;

  // Smart links detection: find [[...]] references into tags/backlinks
  const linked = Array.from(contentText.matchAll(/\[\[([^\]]+)\]\]/g)).map(m => m[1].trim());
  const tags = Array.from(new Set((linked || []).map(s => s.toLowerCase())));

  let contentObj;
  if (passphrase) {
    contentObj = await CryptoAPI.encryptNoteAESWithPassphrase(contentText, passphrase);
  } else if (mode === 'aes') {
    const aesKey = await CryptoAPI.generateAESKey();
    const enc = await CryptoAPI.aesEncrypt(aesKey, contentText);
    enc.exportedKey = await CryptoAPI.aesExportKey(aesKey);
    enc.algo = 'AES-GCM';
    contentObj = enc;
  } else if (mode === 'rsa') {
    const userPub = await localforage.getItem('user:rsa:public');
    if (userPub) {
      const pub = await CryptoAPI.rsaImportPublicKey(userPub);
      const enc = await CryptoAPI.encryptNoteRSAHybrid(contentText, pub);
      contentObj = enc;
    } else {
      alert('No RSA public key found. Use Key Management to generate/import keys, or switch encryption mode.');
      return;
    }
  } else {
    const aesKey = await CryptoAPI.generateAESKey();
    const enc = await CryptoAPI.aesEncrypt(aesKey, contentText);
    enc.exportedKey = await CryptoAPI.aesExportKey(aesKey);
    enc.algo = 'AES-GCM';
    contentObj = enc;
  }

  const now = Date.now();
  const existingNote = currentNoteId ? await DB.getNote(currentNoteId) : null;
  const note = {
    id: currentNoteId || uid('note'),
    title,
    content: contentObj,
    meta: {
      created: currentNoteId && existingNote ? existingNote.meta.created : now,
      modified: now,
      tags
    }
  };
  await DB.saveNote(note);
  if (status) status.textContent = 'Saved';
  await refreshNotesList();
  renderNoteMeta(note);
}

async function deleteCurrentNote() {
  if (!currentNoteId) return;
  await DB.deleteNote(currentNoteId);
  currentNoteId = null;
  const noteTitle = $('#note-title');
  const editor = $('#editor');
  const status = $('#status');
  if (noteTitle) noteTitle.value = '';
  if (editor) editor.value = '';
  await refreshNotesList();
  if (status) status.textContent = 'Deleted';
}

// ---- MODALIZED MINDMAP ----

async function renderMindMap() {
  const svg = document.getElementById('mindmap');
  if (!svg) return;
  svg.innerHTML = '';
  const notes = await DB.listNotes();
  const cx = svg.clientWidth/2 || 400;
  const cy = svg.clientHeight/2 || 300;
  const r = Math.min(cx,cy) - 80;
  const n = notes.length || 1;
  const nodes = notes.map((note, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      id: note.id,
      title: note.title,
      x: cx + Math.cos(angle)*r,
      y: cy + Math.sin(angle)*r,
      meta: note.meta,
      note
    };
  });

  function linkScore(a,b) {
    const plain = (a.note.content && a.note.content.plain) ? a.note.content.plain : '';
    const aLinks = (plain.match(/\[\[([^\]]+)\]\]/g)||[]).map(x=>x.replace(/\[|\]/g,''));
    return aLinks.includes(b.title) ? 1 : 0;
  }
  for (const a of nodes) {
    for (const b of nodes) {
      if (a.id === b.id) continue;
      if (linkScore(a,b)) {
        const line = document.createElementNS('http://www.w3.org/2000/svg','line');
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
        line.setAttribute('stroke', '#999'); line.setAttribute('stroke-width', '1.2');
        svg.appendChild(line);
      }
    }
  }

  for (const node of nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('transform', `translate(${node.x},${node.y})`);
    const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.setAttribute('r','36');
    circle.setAttribute('fill','#fff');
    circle.setAttribute('stroke','#000');
    circle.setAttribute('class','mindmap-node');
    const text = document.createElementNS('http://www.w3.org/2000/svg','text');
    text.setAttribute('y','5');
    text.setAttribute('text-anchor','middle');
    text.setAttribute('font-size','11');
    text.textContent = node.title.slice(0,18);
    g.appendChild(circle);
    g.appendChild(text);
    g.addEventListener('click', async () => {
      closeModal();
      await loadNote(node.id);
    });
    svg.appendChild(g);
  }
}

async function onTimelineZoom() {
  const el = document.getElementById('timeline');
  if (!el) return;
  el.innerHTML = '';
  const notes = await DB.listNotes();
  for (const n of notes) {
    const item = document.createElement('div');
    item.style.padding = '8px'; item.style.marginBottom='6px'; item.style.borderLeft='4px solid var(--primary)';
    item.innerHTML = `<strong>${n.title}</strong><div style="font-size:12px;color:var(--muted)">${new Date(n.meta.created).toLocaleString()}</div>`;
    item.addEventListener('click', () => { closeModal(); loadNote(n.id); });
    el.appendChild(item);
  }
}

// ---------- Key management handlers ----------

async function refreshRSAUI() {
  const kp = await CryptoAPI.getRSAKeypairFromStorage();
  const keyStatus = document.getElementById('key-status');
  const rsaBanner = $('#rsa-banner');
  // Banner in main UI
  if (rsaBanner) {
    if (kp && kp.public) {
      rsaBanner.classList.remove('hidden');
    } else {
      rsaBanner.classList.add('hidden');
    }
  }
  // Modal status
  if (keyStatus) {
    if (kp && kp.public) {
      keyStatus.textContent = 'RSA keys present in browser storage.';
    } else {
      keyStatus.textContent = 'No RSA keys present.';
    }
  }
}

async function onGenerateKeys() {
  const keyStatus = document.getElementById('key-status');
  if (!confirm('Generate a new RSA-4096 keypair locally? The private key will be stored in browser storage. Export it if you want a backup.')) return;
  if (keyStatus) keyStatus.textContent = 'Generating keys... (may take 10-20 seconds)';
  try {
    await CryptoAPI.generateAndStoreRSAKeypair();
    if (keyStatus) keyStatus.textContent = 'Keypair generated and stored locally. Please Export Keys to backup.';
    await refreshRSAUI();
  } catch (e) {
    if (keyStatus) keyStatus.textContent = 'Key generation failed: ' + e;
  }
}

async function onExportKeys() {
  try {
    await CryptoAPI.exportRSAKeypairToFile();
    alert('Exported RSA keypair (download). Keep it safe — do not share private key publicly.');
  } catch (e) {
    alert('No keys to export. Generate or import keys first.');
  }
}

async function onImportKeys() {
  const f = document.createElement('input');
  f.type = 'file';
  f.accept = 'application/json';
  f.onchange = async () => {
    const file = f.files[0];
    if (!file) return;
    try {
      await CryptoAPI.importRSAKeypairFromFile(file);
      alert('Imported keys into browser storage. Consider exporting a backup.');
      await refreshRSAUI();
    } catch (e) {
      alert('Failed to import keys: ' + e);
    }
  };
  f.click();
}

async function onDeleteKeys() {
  if (!confirm('WARNING: This will permanently delete RSA keys from browser storage. Any notes encrypted with RSA-HYBRID will no longer be decryptable if you do not have a backup. Proceed?')) return;
  await CryptoAPI.clearRSAKeypairFromStorage();
  alert('RSA keys removed from browser storage.');
  await refreshRSAUI();
}

window.addEventListener('DOMContentLoaded', init);
