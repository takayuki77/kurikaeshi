/* くりかえし帳 通知係（Cloudflare Worker）
   - アプリから「購読情報＋タスクの予定日」を預かる
   - 毎朝8時（日本時間）に、その日やることがある人へプッシュ通知を送る
   预かるのは タスク名 と 予定日 だけ。メモや写真は端末から出ない。 */
import { sendPush } from './webpush.js';

const ALLOW_ORIGINS = [
  'https://takayuki77.github.io',
  'http://127.0.0.1:8642',   // 動作確認用
  'http://localhost:8642',
];
/* 通知の宛先として認めるサービス（この Worker が他所への送信に悪用されないように） */
const PUSH_HOSTS = ['push.apple.com', 'googleapis.com', 'mozilla.com', 'windows.com'];

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {'Content-Type': 'application/json', ...cors(origin)},
});
function cors(origin){
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
async function keyOf(endpoint){
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return 'sub:' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function validSub(sub, env){
  if(!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
  let host;
  try { host = new URL(sub.endpoint).hostname; } catch(e){ return false; }
  // ALLOW_TEST_HOST は手元での動作確認専用。本番は空
  if(env && env.ALLOW_TEST_HOST && host === env.ALLOW_TEST_HOST) return true;
  return PUSH_HOSTS.some(h => host === h || host.endsWith('.' + h));
}
/* 端末から届いたタスクを、必要な分だけに削る */
function cleanTasks(tasks){
  if(!Array.isArray(tasks)) return [];
  return tasks
    .filter(t => t && typeof t.name === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due || ''))
    .slice(0, 100)
    .map(t => ({name: String(t.name).slice(0, 60), due: t.due}));
}
/* 日本時間の今日（YYYY-MM-DD） */
function todayJst(){
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
/* その日やることから通知の文面を作る。0件なら null（＝送らない） */
export function buildMessage(tasks, today){
  const due = tasks.filter(t => t.due <= today);
  if(!due.length) return null;
  const over = due.filter(t => t.due < today).length;
  const names = due.map(t => t.name);
  const head = names.slice(0, 3).join('、');
  const rest = names.length > 3 ? ` ほか${names.length - 3}件` : '';
  return {
    title: `今日やること ${due.length}件` + (over ? `（${over}件は超過）` : ''),
    body: head + rest,
    badge: due.length,
  };
}

export default {
  async fetch(req, env){
    const origin = req.headers.get('Origin') || '';
    const url = new URL(req.url);
    if(req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors(origin)});
    if(req.method === 'GET' && url.pathname === '/'){
      return new Response('kurikaeshi push worker: ok', {headers: cors(origin)});
    }
    if(req.method !== 'POST') return json({error: 'method'}, 405, origin);

    let data;
    try { data = await req.json(); } catch(e){ return json({error: 'bad json'}, 400, origin); }

    /* 購読の登録・更新（タスクの予定日もここで預かる） */
    if(url.pathname === '/sync'){
      if(!validSub(data.sub, env)) return json({error: 'bad subscription'}, 400, origin);
      const tasks = cleanTasks(data.tasks);
      const key = await keyOf(data.sub.endpoint);
      await env.SUBS.put(key, JSON.stringify({
        sub: {endpoint: data.sub.endpoint, keys: {p256dh: data.sub.keys.p256dh, auth: data.sub.keys.auth}},
        tasks, updatedAt: Date.now(),
      }));
      return json({ok: true, tasks: tasks.length}, 200, origin);
    }

    /* 購読の解除 */
    if(url.pathname === '/unsubscribe'){
      if(typeof data.endpoint !== 'string') return json({error: 'bad endpoint'}, 400, origin);
      await env.SUBS.delete(await keyOf(data.endpoint));
      return json({ok: true}, 200, origin);
    }

    /* 動作確認用：いますぐ1通送る */
    if(url.pathname === '/test'){
      if(typeof data.endpoint !== 'string') return json({error: 'bad endpoint'}, 400, origin);
      const raw = await env.SUBS.get(await keyOf(data.endpoint));
      if(!raw) return json({error: 'not registered'}, 404, origin);
      const rec = JSON.parse(raw);
      const msg = buildMessage(rec.tasks, todayJst()) || {
        title: 'くりかえし帳', body: '通知のテストです。今日やることはありません。', badge: 0,
      };
      const res = await sendPush(rec.sub, msg, env);
      if(res.gone) await env.SUBS.delete(await keyOf(data.endpoint));
      return json({ok: res.ok, status: res.status, sent: msg, detail: res.text}, res.ok ? 200 : 502, origin);
    }

    return json({error: 'not found'}, 404, origin);
  },

  /* 毎朝8時（日本時間）に動く */
  async scheduled(event, env, ctx){
    ctx.waitUntil((async () => {
      const today = todayJst();
      let cursor, sent = 0, skipped = 0, gone = 0;
      do{
        const list = await env.SUBS.list({prefix: 'sub:', cursor});
        cursor = list.list_complete ? null : list.cursor;
        for(const k of list.keys){
          const raw = await env.SUBS.get(k.name);
          if(!raw) continue;
          const rec = JSON.parse(raw);
          const msg = buildMessage(rec.tasks || [], today);
          if(!msg){ skipped++; continue; }
          const res = await sendPush(rec.sub, msg, env);
          if(res.gone){ await env.SUBS.delete(k.name); gone++; }
          else if(res.ok) sent++;
          else console.log('push失敗', res.status, res.text);
        }
      }while(cursor);
      console.log(`通知 ${today}: 送信${sent} / 対象なし${skipped} / 無効${gone}`);
    })());
  },
};
