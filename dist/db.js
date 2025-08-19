// db.js
import { CryptoAPI } from './crypto.js';

const store = localforage.createInstance({ name: "savant_vault_v1" });

export const DB = (function () {

  async function saveNote(note) {
    // note: { id, title, content (encrypted object), meta: { created, modified, tags, mode } }
    await store.setItem(`note:${note.id}`, note);
  }

  async function deleteNote(id) {
    await store.removeItem(`note:${id}`);
  }

  async function listNotes() {
    const keys = await store.keys();
    const notes = [];
    for (const k of keys) {
      if (k.startsWith("note:")) {
        const n = await store.getItem(k);
        notes.push(n);
      }
    }
    // sort by modified desc
    notes.sort((a,b) => (b.meta.modified||0) - (a.meta.modified||0));
    return notes;
  }

  async function getNote(id) {
    return store.getItem(`note:${id}`);
  }

  async function exportVaultBlob(masterPassphrase) {
    // collect all notes, pack into JSON, encrypt with derived passphrase
    const notes = await listNotes();
    const payload = JSON.stringify({ notes, exportedAt: Date.now() });
    // derive key & encrypt
    const { key, saltB64 } = await CryptoAPI.deriveKeyFromPassphrase(masterPassphrase);
    const enc = await CryptoAPI.aesEncrypt(key, payload);
    enc.salt = saltB64;
    return enc;
  }

  async function importVaultBlob(encObj, masterPassphrase) {
    const { key } = await CryptoAPI.deriveKeyFromPassphrase(masterPassphrase, encObj.salt);
    const plain = await CryptoAPI.aesDecrypt(key, encObj);
    const parsed = JSON.parse(plain);
    if (!parsed.notes) throw new Error("Invalid vault blob");
    for (const note of parsed.notes) {
      await saveNote(note);
    }
    return parsed.notes.length;
  }

  return {
    saveNote,
    deleteNote,
    listNotes,
    getNote,
    exportVaultBlob,
    importVaultBlob
  };
})();
