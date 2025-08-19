// app.js
import { CryptoAPI } from './crypto.js';
import { DB } from './db.js';
import { QR } from './qr.js';

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
  $('#clipboard-monitor').checked = clipState;
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
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(dark ? 'light' : 'dark');
  });

  $('#new-note-btn').addEventListener('click', newNote);
  $('#save-note-btn').addEventListener('click', saveNote);
  $('#delete-note-btn').addEventListener('click', deleteCurrentNote);
  $('#qr-share-btn').addEventListener('click', onShareQR);
  $('#export-note-btn').addEventListener('click', onExportNoteHTML);
  $('#open-mindmap').addEventListener('click', openMindMap);
  $('#mindmap-close').addEventListener('click', () => toggleModal('#mindmap-modal', false));
  $('#mindmap-refresh').addEventListener('click', renderMindMap);
  $('#open-timeline').addEventListener('click', () => toggleModal('#timeline-modal', true));
  $('#timeline-close').addEventListener('click', () => toggleModal('#timeline-modal', false));
  $('#timeline-range').addEventListener('input', onTimelineZoom);

  $('#zen-toggle').addEventListener('click', () => {
    document.body.classList.toggle('zen');
    const el = document.getElementById('editor');
    if (document.body.classList.contains('zen')) {
      el.requestFullscreen?.();
      el.classList.add('zen-mode');
    } else {
      document.exitFullscreen?.();
      el.classList.remove('zen-mode');
    }
  });

  $('#export-vault-btn').addEventListener('click', exportVault);
  $('#import-vault-btn').addEventListener('click', importVault);

  $('#close-qr').addEventListener('click', () => toggleModal('#qr-modal', false));
  $('#clipboard-monitor').addEventListener('change', async (e) => {
    // try to request permission gracefully
    const enabled = e.target.checked;
    if (enabled) {
      try {
        // Permissions API: query for clipboard-read
        if (navigator.permissions && navigator.permissions.query) {
          const perm = await navigator.permissions.query({ name: 'clipboard-read' });
          if (perm.state === 'denied') {
            alert('Clipboard access denied by browser. Please allow clipboard access for clipboard monitor to work.');
            e.target.checked = false;
            await localforage.setItem('clipboardMonitor', false);
            return;
          }
          // if prompt or granted, proceed; some browsers still require user gesture to read
        }
        await localforage.setItem('clipboardMonitor', true);
        startClipboardMonitor();
      } catch (err) {
        // Some browsers throw when querying clipboard permission — fallback to trying to read once
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
  });

  $('#search').addEventListener('input', refreshNotesList);

  // Key modal wiring
  $('#open-keys-btn').addEventListener('click', () => toggleModal('#keys-modal', true));
  $('#close-keys').addEventListener('click', () => toggleModal('#keys-modal', false));
  $('#generate-keys-btn').addEventListener('click', onGenerateKeys);
  $('#export-keys-btn').addEventListener('click', onExportKeys);
  $('#import-keys-btn').addEventListener('click', onImportKeys);
  $('#delete-keys-btn').addEventListener('click', onDeleteKeys);
  $('#rsa-export-inline').addEventListener('click', onExportKeys);
}

let clipboardInterval = null;
function startClipboardMonitor() {
  if (clipboardInterval) return;
  clipboardInterval = setInterval(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.length > 20) {
        // dedupe using lastClip
        const last = await localforage.getItem('savant:lastClip');
        if (last === text) return;
        await localforage.setItem('savant:lastClip', text);
        // create quick note
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
      // permission or API not available — stop monitoring and inform user
      stopClipboardMonitor();
      $('#clipboard-monitor').checked = false;
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
  $('#note-title').value = '';
  $('#editor').value = '';
  $('#note-passphrase').value = '';
  currentNoteId = null;
  $('#status').textContent = 'New note';
}

async function refreshNotesList() {
  const q = $('#search').value.trim().toLowerCase();
  const notes = await DB.listNotes();
  const list = $('#notes-list');
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
  if (n.content && (n.content.algo === 'AES-GCM' || n.content.algo === 'RSA-HYBRID')) {
    $('#note-title').value = n.title;
    $('#editor').value = '[ENCRYPTED — enter passphrase (if used) or unlock manually then Save to decrypt]';
    $('#status').textContent = `Encrypted (${n.content.algo})`;
  } else if (n.content && n.content.plain) {
    $('#note-title').value = n.title;
    $('#editor').value = n.content.plain;
    $('#status').textContent = 'Loaded (plain)';
  } else {
    $('#note-title').value = n.title;
    $('#editor').value = '';
    $('#status').textContent = 'Loaded';
  }
  renderNoteMeta(n);
}

function renderNoteMeta(n) {
  const meta = $('#note-meta');
  meta.innerHTML = `
    <div><strong>Title:</strong> ${n.title||'(untitled)'}</div>
    <div><strong>Created:</strong> ${new Date(n.meta.created).toLocaleString()}</div>
    <div><strong>Modified:</strong> ${new Date(n.meta.modified).toLocaleString()}</div>
    <div><strong>Tags:</strong> ${(n.meta.tags||[]).join(', ')}</div>
    <div><strong>Encryption:</strong> ${n.content?.algo || 'none'}</div>
  `;
}

async function saveNote() {
  const title = $('#note-title').value.trim() || 'Untitled';
  const contentText = $('#editor').value;
  const passphrase = $('#note-passphrase').value.trim();
  const mode = $('#encryption-mode').value;

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
      // fallback and warn
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
  const note = {
    id: currentNoteId || uid('note'),
    title,
    content: contentObj,
    meta: {
      created: currentNoteId ? ( (await DB.getNote(currentNoteId)).meta.created ) : now,
      modified: now,
      tags
    }
  };
  await DB.saveNote(note);
  $('#status').textContent = 'Saved';
  await refreshNotesList();
  renderNoteMeta(note);
}

async function deleteCurrentNote() {
  if (!currentNoteId) return;
  await DB.deleteNote(currentNoteId);
  currentNoteId = null;
  $('#note-title').value = '';
  $('#editor').value = '';
  await refreshNotesList();
  $('#status').textContent = 'Deleted';
}

function toggleModal(sel, show) {
  const el = document.querySelector(sel);
  if (!el) return;
  if (show) {
    el.classList.remove('hidden');
  } else el.classList.add('hidden');
}

async function onShareQR() {
  if (!currentNoteId) {
    alert('Save a note first to share it.');
    return;
  }
  const note = await DB.getNote(currentNoteId);
  const payload = JSON.stringify({ meta: note.meta, content: note.content, title: note.title });
  const b64 = btoa(unescape(encodeURIComponent(payload)));
  const canvas = $('#qr-canvas');
  QR.renderToCanvas(b64, canvas, 4);
  toggleModal('#qr-modal', true);
}

async function onExportNoteHTML() {
  if (!currentNoteId) { alert('Save note first'); return; }
  const note = await DB.getNote(currentNoteId);
  const payload = encodeURIComponent(JSON.stringify(note));
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Encrypted Note: ${note.title}</title></head>
<body style="font-family:system-ui;padding:20px;background:#fafafa;color:#111">
  <h2>Encrypted Note: ${note.title}</h2>
  <p>This file contains an encrypted note. To decrypt, enter passphrase (if any) and click Decrypt.</p>
  <input id="pass" placeholder="Passphrase (optional)"/>
  <button id="dec">Decrypt</button>
  <pre id="out"></pre>
  <script>
    const pkg = decodeURIComponent("${payload}");
    const data = JSON.parse(pkg);
    async function decodeWithPass(pass){
      try{
        if (data.content.algo === 'AES-GCM' && data.content.salt){
          const encText = Uint8Array.from(atob(data.content.ciphertext), c => c.charCodeAt(0));
          const iv = Uint8Array.from(atob(data.content.iv), c => c.charCodeAt(0));
          const salt = Uint8Array.from(atob(data.content.salt), c => c.charCodeAt(0));
          const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), {name:'PBKDF2'}, false, ['deriveKey']);
          const key = await crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations:200000, hash:'SHA-256'}, baseKey, {name:'AES-GCM', length:256}, false, ['decrypt']);
          const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, encText);
          document.getElementById('out').textContent = new TextDecoder().decode(plain);
        } else if (data.content.plain) {
          document.getElementById('out').textContent = data.content.plain;
        } else {
          document.getElementById('out').textContent = JSON.stringify(data.content, null, 2);
        }
      } catch(e) { document.getElementById('out').textContent = 'Failed to decrypt: '+e; }
    }
    document.getElementById('dec').addEventListener('click', () => decodeWithPass(document.getElementById('pass').value));
  </script>
</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${note.title.replace(/\s+/g,'_')}.encrypted.html`;
  a.click();
}

async function exportVault() {
  const pass = prompt('Enter a password to encrypt the export (choose a strong password):');
  if (!pass) return;
  const blob = await DB.exportVaultBlob(pass);
  const fileData = JSON.stringify(blob);
  const blobFile = new Blob([fileData], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blobFile);
  a.download = `savant_vault_export_${Date.now()}.json`;
  a.click();
}

async function importVault() {
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'application/json';
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    const text = await f.text();
    const data = JSON.parse(text);
    const pass = prompt('Enter password used to encrypt this export:');
    if (!pass) return;
    try {
      const count = await DB.importVaultBlob(data, pass);
      alert('Imported ' + count + ' notes');
      await refreshNotesList();
    } catch (e) {
      alert('Failed to import: ' + e);
    }
  };
  file.click();
}

async function openMindMap() {
  toggleModal('#mindmap-modal', true);
  await renderMindMap();
}

async function renderMindMap() {
  const svg = $('#mindmap');
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
      toggleModal('#mindmap-modal', false);
      await loadNote(node.id);
    });
    svg.appendChild(g);
  }
}

async function onTimelineZoom(e) {
  const el = $('#timeline');
  el.innerHTML = '';
  const notes = await DB.listNotes();
  for (const n of notes) {
    const item = document.createElement('div');
    item.style.padding = '8px'; item.style.marginBottom='6px'; item.style.borderLeft='4px solid var(--primary)';
    item.innerHTML = `<strong>${n.title}</strong><div style="font-size:12px;color:var(--muted)">${new Date(n.meta.created).toLocaleString()}</div>`;
    item.addEventListener('click', () => { toggleModal('#timeline-modal', false); loadNote(n.id); });
    el.appendChild(item);
  }
}

// ---------- Key management handlers ----------

async function refreshRSAUI() {
  const kp = await CryptoAPI.getRSAKeypairFromStorage();
  if (kp && kp.public) {
    $('#rsa-banner').classList.remove('hidden');
    $('#key-status').textContent = 'RSA keys present in browser storage.';
  } else {
    $('#rsa-banner').classList.add('hidden');
    if ($('#key-status')) $('#key-status').textContent = 'No RSA keys present.';
  }
}

async function onGenerateKeys() {
  if (!confirm('Generate a new RSA-4096 keypair locally? The private key will be stored in browser storage. Export it if you want a backup.')) return;
  $('#key-status').textContent = 'Generating keys... (may take 10-20 seconds)';
  try {
    const exported = await CryptoAPI.generateAndStoreRSAKeypair();
    $('#key-status').textContent = 'Keypair generated and stored locally. Please Export Keys to backup.';
    await refreshRSAUI();
  } catch (e) {
    $('#key-status').textContent = 'Key generation failed: ' + e;
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

// ---------- end key management ----------

window.addEventListener('DOMContentLoaded', init);
