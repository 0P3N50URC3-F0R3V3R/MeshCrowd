// Same checks as mdm.mjs but over a raw CDP websocket, for the Android app WebView (Playwright cannot attach to it).
// Needs: adb reverse tcp:8099 tcp:8099, adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>.
import { Client, BASE, sleep } from './lib.mjs';
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const tag = Date.now().toString(36).slice(-5);
const [c, a, b, d] = ['adc', 'ada', 'adb', 'add'].map((n) => new Client(`${n}${tag}`));
for (const cl of [c, a, b, d]) await cl.register(cl.name, cl.name);
const { dmId } = await c.post('/api/dms/group', { userIds: [a.user.id, b.user.id, d.user.id], name: 'Droid group' });
const msgId = (await a.post(`/api/dms/${dmId}/messages`, { content: 'droid hello' })).message.id;
const { server } = await c.post('/api/servers', { name: 'AEdit ' + tag, visibility: 'private' });
const det = await c.get('/api/servers/' + server.id);
await a.post('/api/servers/join', { inviteCode: det.server.invite_code });
const chId = det.channels[0].id;
const chMsg = (await a.post(`/api/servers/${server.id}/channels/${chId}/messages`, { content: 'channel by a' })).message.id;

const targets = await (await fetch('http://localhost:9222/json')).json();
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const H = `
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const wait=async(sel,ms=15000)=>{const t=Date.now();while(Date.now()-t<ms){const e=document.querySelector(sel);if(e)return e;await sleep(150)}throw new Error('timeout '+sel)};
const lp=async(sel)=>{const e=await wait(sel);e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await sleep(700);e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))};
const fill=async(sel,v)=>{const e=await wait(sel);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))};
const items=()=>[...document.querySelectorAll('.m-sheet-item')].map(e=>e.dataset.id);
`;
const run = (body) => ev(H + body);
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(2500); };

await send('Page.enable');
await nav(BASE + '/m/');
await run(`await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(c.name)},password:'tourpass123'})})`);
await nav(BASE + '/m/');
console.log('webview url', await run('return location.href'));

await run(`(await wait('[data-dm="${dmId}"]',20000)).click(); await wait('.m-msg[data-id="${msgId}"]'); await lp('.m-msg[data-id="${msgId}"]'); await wait('.m-sheet-item')`);
let items = await run('return items()');
check('creator sheet has edit and delete', items.includes('edit') && items.includes('delete'), items.join(','));
await run(`document.querySelector('.m-sheet-item[data-id="edit"]').click(); await sleep(300); await fill('#c-input','droid moderated'); await sleep(200); document.querySelector('#c-send').click(); await sleep(2000)`);
const tagText = await run(`return document.querySelector('.m-msg[data-id="${msgId}"] .m-edited')?.textContent||''`);
check('droid tag says edited by creator', /edited by|szerkesztette/.test(tagText), tagText);
check('group settings button present', await run(`return !!document.querySelector('#m-dm-members')`));
const kick = async (t) => {
  await run(`document.querySelector('#m-dm-members').click(); await wait('.m-sheet-item'); document.querySelector('.m-sheet-item[data-id="${t.user.id}"]').click(); await wait('.m-confirm-row button'); const bs=document.querySelectorAll('.m-confirm-row button'); bs[bs.length-1].click(); await sleep(1800)`);
};
await kick(d);
check('still a group after first kick', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === true);
await kick(b);
check('reverted to 1:1', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === false);
await sleep(1000);
check('settings button gone after revert', !(await run(`return !!document.querySelector('#m-dm-members')`)));
await run(`await lp('.m-msg[data-id="${msgId}"]'); await wait('.m-sheet-item')`);
items = await run('return items()');
check('no edit/delete on others message after revert', !items.includes('edit') && !items.includes('delete'), items.join(','));

await nav(BASE + '/m/');
await run(`await wait('.m-tab'); document.querySelector('[data-tab="servers"]').click(); await sleep(800); (await wait('[data-sid="${server.id}"]')).click(); await sleep(1000); (await wait('[data-cid="${chId}"]')).click(); await wait('.m-msg[data-id="${chMsg}"]'); await lp('.m-msg[data-id="${chMsg}"]'); await wait('.m-sheet-item')`);
items = await run('return items()');
check('owner sheet has edit on member channel message', items.includes('edit'), items.join(','));
await run(`document.querySelector('.m-sheet-item[data-id="edit"]').click(); await sleep(300); await fill('#c-input','owner edit on droid'); await sleep(200); document.querySelector('#c-send').click(); await sleep(2000)`);
const t2 = await run(`return document.querySelector('.m-msg[data-id="${chMsg}"] .m-edited')?.textContent||''`);
check('channel tag says edited by owner on droid', /edited by|szerkesztette/.test(t2), t2);
await send('Page.navigate', { url: 'http://localhost:8072/m/' });
ws.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
