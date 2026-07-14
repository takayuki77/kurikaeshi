/* Web Push の送信部分。ブラウザ標準の暗号機能（WebCrypto）だけで組んである。
   - 本文の暗号化: RFC 8188 (aes128gcm) / RFC 8291
   - 送信元の署名 : RFC 8292 (VAPID, ES256)
   Cloudflare Workers は Node の web-push が使えないため、ここで自前実装している。 */

const enc = new TextEncoder();
const utf8 = s => enc.encode(s);

export function b64urlToBytes(s){
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes){
  let bin = '';
  const b = new Uint8Array(bytes);
  for(let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts){
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for(const p of parts){ out.set(p, at); at += p.length; }
  return out;
}
function u32(n){ return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, key, len * 8);
  return new Uint8Array(bits);
}

/** 購読者の鍵で本文を暗号化する（aes128gcm）。test は再現テスト用に salt と鍵を固定するためのもの */
export async function encryptPayload(payload, p256dh, auth, test){
  const uaPub = b64urlToBytes(p256dh);        // 購読者の公開鍵 65バイト
  const authSecret = b64urlToBytes(auth);     // 購読者の共有秘密 16バイト
  const salt = test?.salt || crypto.getRandomValues(new Uint8Array(16));

  const server = test?.serverKeys || await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public: uaKey}, server.privateKey, 256));

  // RFC 8291: 共有鍵と auth から、この購読者だけが作れる鍵のもと（IKM）を作る
  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info'), new Uint8Array([0]), uaPub, asPub), 32);
  const cek   = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'),     new Uint8Array([0])), 12);

  const RS = 4096;
  const header = concat(salt, u32(RS), new Uint8Array([asPub.length]), asPub);
  const plain = concat(utf8(payload), new Uint8Array([2]));   // 2 = 最後のレコードの目印
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv: nonce}, key, plain));
  return concat(header, body);
}

/** VAPID の署名つきヘッダを作る。privateJwk は秘密鍵（Cloudflareのシークレットから読む） */
export async function vapidHeaders(endpoint, publicKey, privateJwk, subject){
  const aud = new URL(endpoint).origin;
  const head = bytesToB64url(utf8(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const body = bytesToB64url(utf8(JSON.stringify({
    aud, sub: subject, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, utf8(`${head}.${body}`));
  const jwt = `${head}.${body}.${bytesToB64url(sig)}`;
  return {
    'Authorization': `vapid t=${jwt}, k=${publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': '43200',
    'Urgency': 'normal',
  };
}

/** 1件送る。戻り値の ok が false かつ gone が true なら、その購読はもう無効（消してよい） */
export async function sendPush(sub, data, env){
  const payload = JSON.stringify(data);
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const headers = await vapidHeaders(
    sub.endpoint, env.VAPID_PUBLIC, JSON.parse(env.VAPID_PRIVATE_JWK), env.VAPID_SUBJECT,
  );
  const res = await fetch(sub.endpoint, {method:'POST', headers, body});
  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    text: res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200),
  };
}
