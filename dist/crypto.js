// crypto.js
// Exports a small crypto API using Web Crypto for AES-GCM and RSA-OAEP hybrid.
// Includes helpers to store/export/import RSA keys from localForage.

export const CryptoAPI = (function () {
  const subtle = window.crypto.subtle;

  // Helpers
  function str2ab(str) {
    return new TextEncoder().encode(str);
  }
  function ab2str(buf) {
    return new TextDecoder().decode(buf);
  }
  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function base64ToBuf(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  /* AES-GCM symmetric key */
  async function generateAESKey() {
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }

  async function aesExportKey(key) {
    const raw = await subtle.exportKey("raw", key);
    return bufToBase64(raw);
  }
  async function aesImportKey(b64) {
    const raw = base64ToBuf(b64).buffer;
    return subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  async function aesEncrypt(key, plaintext, additional = undefined) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = str2ab(plaintext);
    const algo = { name: "AES-GCM", iv };
    if (additional) algo.additionalData = str2ab(additional);
    const ct = await subtle.encrypt(algo, key, encoded);
    return {
      iv: bufToBase64(iv.buffer),
      ciphertext: bufToBase64(ct),
      algo: "AES-GCM"
    };
  }

  async function aesDecrypt(key, payload, additional = undefined) {
    const iv = base64ToBuf(payload.iv).buffer;
    const ct = base64ToBuf(payload.ciphertext).buffer;
    const algo = { name: "AES-GCM", iv };
    if (additional) algo.additionalData = str2ab(additional);
    const plainBuf = await subtle.decrypt(algo, key, ct);
    return ab2str(plainBuf);
  }

  /* RSA hybrid: generate key pair (for user), export/import public key, encrypt small symmetric keys */
  async function generateRSAKeyPair() {
    const kp = await subtle.generateKey({
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    }, true, ["encrypt", "decrypt"]);
    return kp;
  }

  async function rsaExportPublicKey(key) {
    const spki = await subtle.exportKey("spki", key);
    return bufToBase64(spki);
  }

  async function rsaImportPublicKey(b64) {
    const spki = base64ToBuf(b64).buffer;
    return subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
  }

  async function rsaImportPrivateKey(b64) {
    const pkcs8 = base64ToBuf(b64).buffer;
    return subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
  }

  async function rsaExportPrivateKey(key) {
    const pk = await subtle.exportKey("pkcs8", key);
    return bufToBase64(pk);
  }

  async function rsaEncryptWithPublicKey(publicKey, dataUint8) {
    const ct = await subtle.encrypt({ name: "RSA-OAEP" }, publicKey, dataUint8);
    return bufToBase64(ct);
  }
  async function rsaDecryptWithPrivateKey(privateKey, b64ct) {
    const ct = base64ToBuf(b64ct).buffer;
    const pt = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, ct);
    return new Uint8Array(pt);
  }

  /* Derived keys for passphrase */
  async function deriveKeyFromPassphrase(passphrase, saltB64, usages = ["encrypt", "decrypt"]) {
    const salt = saltB64 ? base64ToBuf(saltB64).buffer : window.crypto.getRandomValues(new Uint8Array(16)).buffer;
    const baseKey = await subtle.importKey("raw", str2ab(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await subtle.deriveKey({
      name: "PBKDF2",
      salt,
      iterations: 200_000,
      hash: "SHA-256"
    }, baseKey, { name: "AES-GCM", length: 256 }, true, usages);
    return { key, saltB64: bufToBase64(salt) };
  }

  /* AES passphrase encrypt/decrypt helpers */
  async function encryptNoteAESWithPassphrase(plaintext, passphrase) {
    const { key, saltB64 } = await deriveKeyFromPassphrase(passphrase);
    const payload = await aesEncrypt(key, plaintext);
    payload.salt = saltB64;
    payload.algo = 'AES-GCM';
    return payload;
  }

  async function decryptNoteAESWithPassphrase(payload, passphrase) {
    const imported = await deriveKeyFromPassphrase(passphrase, payload.salt);
    const plain = await aesDecrypt(imported.key, payload);
    return plain;
  }

  // Hybrid RSA: encrypt plaintext using ephemeral AES; encrypt AES key with RSA public key
  async function encryptNoteRSAHybrid(plaintext, rsaPublicKey) {
    const aesKey = await generateAESKey();
    const exportedAes = await aesExportKey(aesKey);
    const encrypted = await aesEncrypt(aesKey, plaintext);
    // encrypt exportedAes raw bytes with RSA public key
    const encryptedKey = await rsaEncryptWithPublicKey(rsaPublicKey, base64ToBuf(exportedAes));
    return {
      algo: "RSA-HYBRID",
      encryptedKey,
      payload: encrypted
    };
  }

  async function decryptNoteRSAHybrid(obj, rsaPrivateKey) {
    const keyBytes = await rsaDecryptWithPrivateKey(rsaPrivateKey, obj.encryptedKey);
    const aesKey = await subtle.importKey("raw", keyBytes.buffer, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    const plaintext = await aesDecrypt(aesKey, obj.payload);
    return plaintext;
  }

  /* RSA key storage helpers using localForage (frontend) */
  async function saveRSAKeypairToStorage(spkiB64, pkcs8B64) {
    await localforage.setItem('user:rsa:public', spkiB64);
    await localforage.setItem('user:rsa:private', pkcs8B64);
  }

  async function clearRSAKeypairFromStorage() {
    await localforage.removeItem('user:rsa:public');
    await localforage.removeItem('user:rsa:private');
  }

  async function getRSAKeypairFromStorage() {
    const pub = await localforage.getItem('user:rsa:public');
    const priv = await localforage.getItem('user:rsa:private');
    return { public: pub, private: priv };
  }

  async function exportRSAKeypairToFile(filename = `savant_rsa_keys_${Date.now()}.json`) {
    const kp = await getRSAKeypairFromStorage();
    if (!kp.public || !kp.private) throw new Error('No RSA keys in storage');
    const blob = new Blob([JSON.stringify(kp)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  async function importRSAKeypairFromFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.public || !parsed.private) throw new Error('Invalid key file');
    await saveRSAKeypairToStorage(parsed.public, parsed.private);
    return parsed;
  }

  async function exportRSAKeypair(kp) {
    // kp is a subtle keypair; return base64 strings
    const pub = await rsaExportPublicKey(kp.publicKey);
    const priv = await rsaExportPrivateKey(kp.privateKey);
    return { public: pub, private: priv };
  }

  async function generateAndStoreRSAKeypair() {
    const kp = await generateRSAKeyPair();
    const exported = await exportRSAKeypair(kp);
    await saveRSAKeypairToStorage(exported.public, exported.private);
    return exported;
  }

  return {
    generateAESKey,
    aesExportKey,
    aesImportKey,
    aesEncrypt,
    aesDecrypt,
    generateRSAKeyPair,
    rsaExportPublicKey,
    rsaExportPrivateKey,
    rsaImportPublicKey,
    rsaImportPrivateKey,
    encryptNoteAESWithPassphrase,
    decryptNoteAESWithPassphrase,
    encryptNoteRSAHybrid,
    decryptNoteRSAHybrid,
    deriveKeyFromPassphrase,
    // storage helpers
    saveRSAKeypairToStorage,
    clearRSAKeypairFromStorage,
    getRSAKeypairFromStorage,
    generateAndStoreRSAKeypair,
    exportRSAKeypairToFile,
    importRSAKeypairFromFile,
    // placeholders
    isChaChaAvailable: false,
    // helper conversions
    bufToBase64,
    base64ToBuf
  };
})();
