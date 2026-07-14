/* くりかえし帳 — 日付と周期の計算（画面がなくても動く部分だけをここに置く） */
const p2 = n => String(n).padStart(2, '0');
function dstr(d){ return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function parseDate(s){ const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function todayStr(){ return dstr(new Date()); }
function addDays(s, n){ const d = parseDate(s); d.setDate(d.getDate() + n); return dstr(d); }
function addMonths(s, n){
  // 1/31 の1か月後は 2/28(29) のように、月末を超えないよう丸める
  const d = parseDate(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return dstr(d);
}
function diffDays(a, b){ return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

/* 完了した日から、次にやる日を出す（7/14に完了・1週間ごと → 7/21） */
function nextFrom(s, task){
  if(task.unit === 'month') return addMonths(s, task.every);
  if(task.unit === 'week')  return addDays(s, task.every * 7);
  return addDays(s, task.every);
}
function unitLabel(unit){
  return unit === 'month' ? 'か月' : unit === 'week' ? '週間' : '日';
}
function intervalLabel(task){
  if(task.type !== 'interval') return 'いつでも';
  return task.every + unitLabel(task.unit) + 'ごと';
}
function agoLabel(dateStr, t){
  const d = diffDays(dateStr, t);
  if(d <= 0) return '今日';
  if(d === 1) return '昨日';
  return d + '日前';
}
/* 一覧の右端に出す表示。cls: over=超過 / due=今日 / ok=まだ先 */
function dueLabel(task, t){
  if(task.type !== 'interval') return null;
  const d = diffDays(t, task.nextDue);
  if(d < 0) return {text: (-d) + '日超過', cls: 'over'};
  if(d === 0) return {text: '今日', cls: 'due'};
  return {text: 'あと' + d + '日', cls: 'ok'};
}
/* 平均間隔（日）。記録が2件未満なら null */
function avgInterval(dateStrs){
  if(dateStrs.length < 2) return null;
  const s = dateStrs.slice().sort();
  let sum = 0;
  for(let i = 1; i < s.length; i++) sum += diffDays(s[i - 1], s[i]);
  return Math.round(sum / (s.length - 1));
}

if(typeof module !== 'undefined') module.exports = {dstr, parseDate, todayStr, addDays, addMonths, diffDays, nextFrom, unitLabel, intervalLabel, agoLabel, dueLabel, avgInterval};
