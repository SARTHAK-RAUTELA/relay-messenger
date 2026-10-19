// End-to-end encryption for secret chats (WebCrypto only; nothing here talks to the server).
//
// Each browser holds one ECDH P-256 key pair per account. The private key is generated as
// non-extractable and stays in IndexedDB. A secret chat records both participants' public keys
// when it is created; the chat key is HKDF-SHA-256(ECDH(mine, theirs)) bound to the chat id,
// and every message is AES-256-GCM with a fresh 96-bit IV and the chat id as associated data.
// Wire format: "e1:" + base64(iv) + ":" + base64(ciphertext+tag).

export interface SecretKeyStore {
  load(userId: number): Promise<CryptoKeyPair | null>;
  save(userId: number, pair: CryptoKeyPair): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto | null {
  return (globalThis as { crypto?: Crypto }).crypto?.subtle ?? null;
}

/** WebCrypto is only available in secure contexts (https or localhost). */
export function secretSupported(): boolean {
  return subtle() != null;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return subtle()!.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(await subtle()!.exportKey("raw", key));
}

export async function deriveChatKey(myPrivate: CryptoKey, theirPublic: string, secretId: number): Promise<CryptoKey> {
  const s = subtle()!;
  const pub = await s.importKey("raw", fromBase64(theirPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await s.deriveBits({ name: "ECDH", public: pub }, myPrivate, 256);
  const hkdf = await s.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("relay-secret-chat-v1"), info: enc.encode(`chat:${secretId}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (secretId: number) => enc.encode(`relay:${secretId}`);

export async function encryptText(key: CryptoKey, text: string, secretId: number): Promise<string> {
  const iv = (globalThis as { crypto: Crypto }).crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle()!.encrypt({ name: "AES-GCM", iv, additionalData: aad(secretId) }, key, enc.encode(text));
  return `e1:${toBase64(iv)}:${toBase64(ct)}`;
}

/** Throws when the payload is malformed or was not encrypted with this key for this chat. */
export async function decryptText(key: CryptoKey, payload: string, secretId: number): Promise<string> {
  const m = /^e1:([^:]+):([^:]+)$/.exec(payload);
  if (!m) throw new Error("not a secret-chat payload");
  const pt = await subtle()!.decrypt(
    { name: "AES-GCM", iv: fromBase64(m[1]), additionalData: aad(secretId) },
    key,
    fromBase64(m[2]),
  );
  return dec.decode(pt);
}

/** Short code both people can compare out of band to rule out a swapped key. */
export async function keyFingerprint(initiatorKey: string, responderKey: string): Promise<string> {
  const digest = new Uint8Array(await subtle()!.digest("SHA-256", enc.encode(`${initiatorKey}|${responderKey}`)));
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return hex.match(/.{4}/g)!.join(" ");
}

/** In-memory store (tests, and browsers without IndexedDB). */
export class MemoryKeyStore implements SecretKeyStore {
  private keys = new Map<number, CryptoKeyPair>();
  async load(userId: number) {
    return this.keys.get(userId) ?? null;
  }
  async save(userId: number, pair: CryptoKeyPair) {
    this.keys.set(userId, pair);
  }
}

/** Browser store: CryptoKey objects are stored as-is, so the private key stays non-extractable. */
export class IndexedDbKeyStore implements SecretKeyStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("relay-secret", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async load(userId: number): Promise<CryptoKeyPair | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("keys").objectStore("keys").get(userId);
      req.onsuccess = () => resolve((req.result as CryptoKeyPair | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(userId: number, pair: CryptoKeyPair): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(pair, userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
