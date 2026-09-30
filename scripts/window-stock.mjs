// 微信小店带货助手 · 橱窗库存巡检（kimi-webbridge 驱动）
//
// 用途：扫 https://store.weixin.qq.com/talent/channel/window 全部橱窗商品，
//       挑出 0 库存 / 低库存商品，并给出每个商品的商品短链（微信内可打开）。
//       可选：把 0 库存商品一键「隐藏」/「取消隐藏」。
//
// 只读铁律：status / list / scan 三个模式只调 list / getQrcode 两个查询接口，
//           绝不改价、改库存、改佣金、改推荐语、移除商品。
//           只有 hide / unhide 会写数据，且必须显式加 --apply 才会执行，默认 dry-run。
//
// 踩过的坑（改脚本前必读）：
//  1) shop-faas 接口必须带页面自身请求里的 potter-scene / biz_magic / talent_magic 头，
//     否则 403 {"respStatusCode":200004,"msg":"mcn magic invalid"}。magic 靠给页面打 XHR 钩子抄。
//  2) 页面内容在 <micro-app> 的 shadowRoot 里，普通 document.querySelector 取不到商品行。
//  3) 页面内 evaluate 只做同步动作/单次 fetch，等待全部放 Node 端。后台 tab 的定时器被限流。
//  4) 商品短链不是拼出来的：调 getQrcode 拿二维码图，再用 zbarimg 解出 mp.weixin.qq.com 短链。
//  5) 佣金率字段是 commissionRate/10000；价格是 minPrice/100（分）。
//
// 用法：
//   node window-stock.mjs scan   [--max-stock 0] [--out <基础路径>] [--no-link]
//   node window-stock.mjs list   [--max-stock 0] [--no-link]
//   node window-stock.mjs status
//   node window-stock.mjs hide   [--max-stock 0] [--ids a,b] [--limit 50] [--apply]
//   node window-stock.mjs unhide [--ids a,b] [--limit 50] [--apply]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.KWB_PORT || 10086);
const SESSION = process.env.KWB_SESSION || 'wx-window-stock';
const PAGE_URL = 'https://store.weixin.qq.com/talent/channel/window';
const LIST_URL = 'https://store.weixin.qq.com/shop-faas/mmeckolwindownode/window/getTalentWindowProducts?token=&lang=zh_CN';
const QR_URL = 'https://store.weixin.qq.com/shop-faas/mmeckolbasenode/base/getQrcode?token=&lang=zh_CN';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const mode = args[0] || 'status';
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);
const MAX_STOCK = Number(opt('max-stock', 0));
const NO_LINK = flag('no-link');

function daemon(body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/command', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('daemon 返回非 JSON: ' + buf.slice(0, 200))); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon 调用超时 ' + timeoutMs + 'ms')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function ev(code, timeoutMs = 60000) {
  const j = await daemon({ action: 'evaluate', args: { code }, session: SESSION }, timeoutMs);
  if (!j.ok) throw new Error('evaluate 失败: ' + JSON.stringify(j).slice(0, 300));
  return j.data && j.data.type === 'string' ? j.data.value : JSON.stringify(j.data);
}

const SR = 'document.querySelector("micro-app")&&document.querySelector("micro-app").shadowRoot';

// ---------- 页面内片段（全部同步，或只做单次 fetch） ----------
const S_PING = `(()=>{const sr=${SR};if(!sr)return JSON.stringify({err:"no_micro_app"});
const cur=sr.querySelector(".weui-desktop-pagination__num_current");
const nums=[...sr.querySelectorAll(".weui-desktop-pagination__num")].map(n=>n.textContent.trim()).filter(t=>/^\\d+$/.test(t));
const rows=sr.querySelectorAll("tr .commodity-info-wrap").length;
return JSON.stringify({title:document.title,url:location.href,page:cur?Number(cur.textContent.trim()):null,maxPage:nums.length?Math.max(...nums.map(Number)):1,rowsOnPage:rows});})()`;

// 给页面的 XHR / fetch 打钩子，抄下它自己发的请求体与请求头（magic 就在里面）
const S_TAP = `(()=>{if(window.__wsTap)return JSON.stringify({tap:"already"});
window.__wsTap=[];
const OX=XMLHttpRequest.prototype.open,OS=XMLHttpRequest.prototype.send,OH=XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open=function(m,u){this.__wsu=u;this.__wsm=m;this.__wsh={};return OX.apply(this,arguments);};
XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{this.__wsh[k]=v;}catch(e){}return OH.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(b){try{window.__wsTap.push({u:this.__wsu,m:this.__wsm,hs:this.__wsh,b:typeof b==="string"?b:""});}catch(e){}return OS.apply(this,arguments);};
const OF=window.fetch;
window.fetch=function(...a){try{const u=typeof a[0]==="string"?a[0]:(a[0]&&a[0].url);const o=a[1]||{};window.__wsTap.push({u,m:o.method||"GET",hs:o.headers||{},b:typeof o.body==="string"?o.body:""});}catch(e){}return OF.apply(this,arguments);};
return JSON.stringify({tap:"installed"});})()`;

// 翻一页，逼页面自己再发一次 list 请求，好让钩子抄到 magic
const S_POKE = `(()=>{const sr=${SR};if(!sr)return JSON.stringify({err:"no_micro_app"});
const nx=[...sr.querySelectorAll("a")].find(a=>/下一页/.test(a.textContent.trim())&&!/disabled/.test(a.className||""));
if(nx){nx.click();return JSON.stringify({poke:"next"});}
const inp=sr.querySelector(".weui-desktop-pagination__input");
if(inp){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
setter.call(inp,"2");inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));
const go=[...sr.querySelectorAll("a")].find(a=>a.textContent.trim()==="跳转");if(go){go.click();return JSON.stringify({poke:"jump2"});}}
return JSON.stringify({err:"no_pager"});})()`;

const S_MAGIC = `(()=>{const t=(window.__wsTap||[]).filter(x=>x.hs&&(x.hs.biz_magic||x.hs["biz_magic"]));
const h=t.slice(-1)[0];if(!h)return JSON.stringify({err:"no_magic"});
return JSON.stringify({scene:h.hs["potter-scene"]||"talent",biz:h.hs.biz_magic,talent:h.hs.talent_magic});})()`;

const mkList = (mg, offset, pageSize) => `(async()=>{const m=${JSON.stringify(mg)};
const r=await fetch(${JSON.stringify(LIST_URL)},{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","potter-scene":m.scene,"biz_magic":m.biz,"talent_magic":m.talent},body:JSON.stringify({pageSize:${pageSize},offset:${offset},productSource:null,reqSource:1})});
const t=await r.text();if(r.status!==200)return JSON.stringify({httpStatus:r.status,raw:t.slice(0,200)});
let j;try{j=JSON.parse(t)}catch(e){return JSON.stringify({httpStatus:r.status,raw:t.slice(0,200)})}
const d=j.data||{};const ps=(d.products||[]).map(p=>({productId:p.productId,outProductId:p.outProductId,title:p.title,stock:p.stock,minPrice:p.minPrice,maxPrice:p.maxPrice,shop:p.platformName,status:p.status,statusWording:p.statusWording,sales:p.sales,commissionRate:(p.commissionInfo||{}).commissionRate,commissionEstimate:(p.commissionInfo||{}).commissionEstimate,cpsSpuId:((p.previewPageParam||{}).cpsSpuId)||"",cpsLink:((p.previewPageParam||{}).cpsLink)||"",isHide:!!((p.itemDecoreate||{}).isHide),isTop:!!((p.itemDecoreate||{}).isTop)}));
return JSON.stringify({code:j.code,count:ps.length,continueFlag:!!d.continueFlag,products:ps});})()`;

const mkQr = (mg, opid, cpsLink) => `(async()=>{const m=${JSON.stringify(mg)};
const p="/pool/pages/detail/index?shopId=${opid}&link=${cpsLink}&entrance=8";
const r=await fetch(${JSON.stringify(QR_URL)},{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","potter-scene":m.scene,"biz_magic":m.biz,"talent_magic":m.talent},body:JSON.stringify({bizType:1,path:p,lifespan:43200,isNeedAppid:true,onlyAdmin:false,needLogin:true})});
const t=await r.text();if(r.status!==200)return JSON.stringify({httpStatus:r.status,raw:t.slice(0,200)});
let j;try{j=JSON.parse(t)}catch(e){return JSON.stringify({httpStatus:r.status,raw:t.slice(0,200)})}
return JSON.stringify({code:j.code,success:j.success,img:j.qrcodeImg||"",localPath:j.localPath||""});})()`;

// ---------- 环境 ----------
async function ensureTab() {
  let list;
  try { list = await daemon({ action: 'list_tabs', args: {}, session: SESSION }, 15000); }
  catch { throw new Error('连不上 kimi-webbridge daemon(127.0.0.1:' + PORT + ')。先跑: ~/.kimi-webbridge/bin/kimi-webbridge status'); }
  if (!list.ok) throw new Error('daemon 无响应: ' + JSON.stringify(list).slice(0, 200));
  const tabs = (list.data && list.data.tabs) || [];
  if (tabs.some(t => (t.url || '').includes('/talent/channel/window'))) return;
  const r = await daemon({ action: 'navigate', args: { url: PAGE_URL, newTab: true, group_title: '橱窗库存巡检' }, session: SESSION }, 40000);
  if (!r.ok) throw new Error('打开页面失败: ' + JSON.stringify(r).slice(0, 200));
  await sleep(6000);
}

async function getMagic() {
  for (let i = 0; i < 6; i++) {
    const m = JSON.parse(await ev(S_MAGIC));
    if (!m.err && m.biz) return m;
    const p = JSON.parse(await ev(S_POKE));
    if (p.err) throw new Error('页面没找到分页控件(' + p.err + ')。请手动在橱窗页面翻一页/刷新一次后重跑。');
    await sleep(2500);
  }
  throw new Error('抓不到 biz_magic/talent_magic 头。请确认 Chrome 已登录 store.weixin.qq.com 带货助手，且页面停留在橱窗页后重跑。');
}

const hasZbar = (() => { try { execFileSync('which', ['zbarimg'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function decodeQr(base64Jpeg, tag) {
  if (!hasZbar) return { link: '', why: 'no_zbarimg' };
  const dir = path.join(os.tmpdir(), 'wx-window-stock-qr');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, tag + '.jpg');
  fs.writeFileSync(f, Buffer.from(base64Jpeg, 'base64'));
  try { return { link: execFileSync('zbarimg', ['--quiet', '--raw', f], { encoding: 'utf8' }).trim(), file: f }; }
  catch { return { link: '', why: 'decode_failed', file: f }; }
}

// ---------- DOM 驱动：翻页 / 找行 / 点隐藏（写操作，只有 hide/unhide --apply 会走到） ----------
const S_CURPAGE = `(()=>{const sr=${SR};const c=sr.querySelector(".weui-desktop-pagination__num_current");return JSON.stringify({page:c?Number(c.textContent.trim()):1});})()`;

const S_PIDS = `(()=>{const sr=${SR};const pids=[];for(const row of sr.querySelectorAll("tr")){const w=row.querySelector(".commodity-info-wrap");if(!w)continue;pids.push((w.id||"").replace("commodity-",""));}
const c=sr.querySelector(".weui-desktop-pagination__num_current");
const nums=[...sr.querySelectorAll(".weui-desktop-pagination__num")].map(n=>n.textContent.trim()).filter(t=>/^\\d+$/.test(t));
return JSON.stringify({page:c?Number(c.textContent.trim()):1,maxPage:nums.length?Math.max(...nums.map(Number)):1,pids});})()`;

const S_GOTO = n => `(()=>{const sr=${SR};const c=sr.querySelector(".weui-desktop-pagination__num_current");
if(c&&c.textContent.trim()==="${n}")return JSON.stringify({ok:1,same:1});
const inp=sr.querySelector(".weui-desktop-pagination__input");
if(!inp)return JSON.stringify({err:"no_jump_input"});
const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
setter.call(inp,"${n}");inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));
const go=[...sr.querySelectorAll("a")].find(a=>a.textContent.trim()==="跳转");
if(!go)return JSON.stringify({err:"no_jump_btn"});
go.click();return JSON.stringify({ok:1});})()`;

// 注意：这两行的「隐藏 / 取消隐藏」是 div.link-btn，点下去立即生效，平台没有二次确认弹窗。
const S_CLICK = (pid, label) => `(()=>{const sr=${SR};
for(const row of sr.querySelectorAll("tr")){const w=row.querySelector(".commodity-info-wrap");if(!w)continue;
if((w.id||"").replace("commodity-","")!=="${pid}")continue;
const td=[...row.querySelectorAll("td")].pop();
const btn=[...td.querySelectorAll(".link-btn")].find(b=>b.innerText.trim()===${JSON.stringify(label)});
if(!btn)return JSON.stringify({err:"no_btn",acts:td.innerText.replace(/\\s+/g,"|")});
btn.click();return JSON.stringify({ok:1});}
return JSON.stringify({err:"row_not_found"});})()`;

const S_ROW_ACTS = pid => `(()=>{const sr=${SR};
for(const row of sr.querySelectorAll("tr")){const w=row.querySelector(".commodity-info-wrap");if(!w)continue;
if((w.id||"").replace("commodity-","")!=="${pid}")continue;
return JSON.stringify({acts:[...row.querySelectorAll("td")].pop().innerText.replace(/\\s+/g,"|")});}
return JSON.stringify({err:"row_not_found"});})()`;

async function gotoPage(n) {
  const cur = JSON.parse(await ev(S_CURPAGE)).page;
  if (cur === n) return true;
  const before = JSON.parse(await ev(S_PIDS)).pids.join(',');
  await ev(S_GOTO(n));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const d = JSON.parse(await ev(S_PIDS));
    if (d.page === n && d.pids.join(',') !== before) return true;
  }
  return false;
}

// targetIds 里的商品跨页扫一遍，逐个点 隐藏 / 取消隐藏；返回逐条结果
async function doAction(label, targetIds, onStep) {
  const flip = label === '隐藏' ? '取消隐藏' : '隐藏';
  const isDone = acts => label === '隐藏' ? acts.includes('取消隐藏') : (acts.includes('隐藏') && !acts.includes('取消隐藏'));
  const results = [];
  const { maxPage } = JSON.parse(await ev(S_PIDS));
  for (let p = 1; p <= maxPage; p++) {
    if (!(await gotoPage(p))) { results.push({ productId: `page${p}`, err: 'goto_page_failed' }); continue; }
    const onPage = new Set(JSON.parse(await ev(S_PIDS)).pids);
    for (const id of targetIds) {
      if (!onPage.has(id)) continue;
      const c = JSON.parse(await ev(S_CLICK(id, label)));
      if (c.err) { results.push({ productId: id, ok: false, err: c.err, acts: c.acts }); onStep && onStep(id, false); continue; }
      let ok = false;
      for (let i = 0; i < 20; i++) {
        await sleep(700);
        const a = JSON.parse(await ev(S_ROW_ACTS(id)));
        if (a.acts && isDone(a.acts)) { ok = true; break; }
      }
      results.push({ productId: id, ok, step: label });
      onStep && onStep(id, ok);
    }
  }
  return results;
}

// ---------- 主流程 ----------
async function fetchAll(magic) {
  const all = [];
  for (let off = 0; off < 5000; off += 100) {
    let j = JSON.parse(await ev(mkList(magic, off, 100)));
    if (j.httpStatus && /magic/i.test(j.raw || '')) { magic = await getMagic(); j = JSON.parse(await ev(mkList(magic, off, 100))); }
    if (j.httpStatus) throw new Error('list 接口返回 ' + j.httpStatus + ': ' + (j.raw || ''));
    all.push(...(j.products || []));
    if (!j.continueFlag || !j.count) break;
    await sleep(300);
  }
  return { magic, all: [...new Map(all.map(p => [p.productId, p])).values()] };
}

function buildRows(products) {
  return products
    .filter(p => p.stock <= MAX_STOCK)
    .sort((a, b) => a.stock - b.stock || b.sales - a.sales);
}

const yuan = v => (Number(v || 0) / 100).toFixed(2);
const rate = v => (Number(v || 0) / 10000).toFixed(1) + '%';

function writeFiles(outBase, data) {
  const { all, rows, magic } = data;
  const md = [];
  md.push('# 橱窗库存巡检（库存 ≤ ' + MAX_STOCK + '）', '');
  md.push('- 页面：' + PAGE_URL);
  md.push('- 巡检时间：' + new Date().toLocaleString('zh-CN'));
  md.push('- 橱窗商品总数：' + all.length + '　命中（库存 ≤ ' + MAX_STOCK + '）：' + rows.length);
  md.push('- 口径：带货助手橱窗列表接口 stock 字段，只读；短链由后台「详情」二维码解码得到');
  md.push('');
  md.push('| # | 商品 | 店铺 | 价格 | 佣金率 | 预估佣金 | 库存 | 销量 | 状态 | 商品短链 |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((z, i) => md.push(`| ${i + 1} | ${z.title.replace(/\|/g, '/')} | ${z.shop} | ¥${yuan(z.minPrice)} | ${rate(z.commissionRate)} | ¥${yuan(z.commissionEstimate)} | **${z.stock}** | ${z.sales} | ${z.statusWording}${z.isHide ? '/已隐藏' : ''} | ${z.shortLink || ''} |`));
  md.push('', '## 明细', '');
  rows.forEach((z, i) => {
    md.push(`### ${i + 1}. ${z.title}`);
    md.push(`- 店铺：${z.shop}　价格：¥${yuan(z.minPrice)}　佣金率：${rate(z.commissionRate)}　预估佣金：¥${yuan(z.commissionEstimate)}`);
    md.push(`- 库存：${z.stock}　销量：${z.sales}　售卖状态：${z.statusWording}　橱窗展示：${z.isHide ? '已隐藏' : '未隐藏'}${z.isTop ? '（已置顶）' : ''}`);
    md.push(`- 商品ID：${z.productId}　spuId：${z.outProductId}`);
    md.push(`- 机构链接：${z.cpsLink}`);
    md.push(`- 商品短链（微信内打开）：${z.shortLink || '（未取到，看' + (z.qrErr || 'zbarimg') + '）'}`);
    md.push('');
  });
  fs.writeFileSync(outBase + '.md', md.join('\n'));

  const head = ['商品名', '店铺', '价格(元)', '佣金率', '预估佣金(元)', '库存', '销量', '售卖状态', '橱窗展示', '商品ID', 'spuId', '机构链接(cpsLink)', '商品短链'];
  const csv = '\ufeff' + [head.join(','), ...rows.map(z => ['"' + z.title.replace(/"/g, '""') + '"', z.shop, yuan(z.minPrice), rate(z.commissionRate), yuan(z.commissionEstimate), z.stock, z.sales, z.statusWording, z.isHide ? '已隐藏' : '未隐藏', z.productId, z.outProductId, z.cpsLink, z.shortLink || ''].join(','))].join('\n') + '\n';
  fs.writeFileSync(outBase + '.csv', csv);
  fs.writeFileSync(outBase + '.json', JSON.stringify({ scannedAt: new Date().toISOString(), page: PAGE_URL, maxStock: MAX_STOCK, total: all.length, hits: rows.length, rows, all }, null, 1));
}

async function main() {
  await ensureTab();
  await ev(S_TAP);
  const ping = JSON.parse(await ev(S_PING));
  if (ping.err) throw new Error('页面还没加载出 micro-app，等几秒重跑。');
  let magic = await getMagic();
  const r = await fetchAll(magic);
  magic = r.magic;
  const all = r.all;
  const rows = buildRows(all);

  if (mode === 'status') {
    console.log(JSON.stringify({ page: ping.url, total: all.length, maxStock: MAX_STOCK, hits: rows.length }, null, 1));
    return;
  }

  // ---------- 写操作：hide / unhide（默认 dry-run，必须显式 --apply） ----------
  if (mode === 'hide' || mode === 'unhide') {
    const label = mode === 'hide' ? '隐藏' : '取消隐藏';
    const limit = Number(opt('limit', 50));
    const idsArg = (opt('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (mode === 'unhide' && !idsArg.length && !flag('all')) {
      console.log('unhide 必须显式限定范围：--ids <商品ID,...>（只放这几个），或 --all（把所有已隐藏的都放出来）。');
      return;
    }
    let targets = idsArg.length
      ? all.filter(p => idsArg.includes(p.productId))
      : all.filter(p => mode === 'hide' ? (!p.isHide && p.stock <= MAX_STOCK) : p.isHide);
    if (targets.length > limit) { console.log(`命中 ${targets.length} 个，超过 --limit ${limit}，只处理前 ${limit} 个（要全量就传 --limit ${targets.length}）。`); targets = targets.slice(0, limit); }
    if (!targets.length) { console.log(`没有需要「${label}」的商品。`); return; }

    console.log(`${label}目标 ${targets.length} 个${flag('apply') ? '' : '　—— dry-run，不会真的改'}`);
    targets.forEach(z => console.log(`  [库存 ${z.stock}｜${z.isHide ? '已隐藏' : '未隐藏'}] ${z.title.slice(0, 30)}　${z.shop}`));
    if (!flag('apply')) { console.log('\n这是预演。确认无误后加 --apply 才会真的执行。'); return; }

    const before = targets.map(t => ({ productId: t.productId, title: t.title, stock: t.stock, isHide: t.isHide }));
    const results = await doAction(label, targets.map(t => t.productId), (id, ok) => console.log(`  ${ok ? '✓' : '✗'} ${id}`));

    // 复核：重新拉一次列表，以接口的 isHide 为准，不信 UI 的一瞬间
    await sleep(1500);
    const after = (await fetchAll(magic)).all;
    const afterMap = new Map(after.map(p => [p.productId, p]));
    const report = before.map(b => {
      const a = afterMap.get(b.productId);
      const want = label === '隐藏';
      const nowHide = a ? !!a.isHide : null;
      return { ...b, nowHide, ok: nowHide === want };
    });
    const okN = report.filter(x => x.ok).length;
    console.log(`\n${label}完成：${okN}/${report.length} 成功（以接口 isHide 复核）`);
    report.filter(x => !x.ok).forEach(x => console.log(`  未生效：${x.title.slice(0, 30)}（当前 isHide=${x.nowHide}）`));
    if (results.some(x => x.err)) console.log('  点击异常：' + JSON.stringify(results.filter(x => x.err)).slice(0, 300));

    const dd = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const logBase = path.join(os.homedir(), 'Desktop', `橱窗${label}记录_${dd.getFullYear()}${p2(dd.getMonth() + 1)}${p2(dd.getDate())}_${p2(dd.getHours())}${p2(dd.getMinutes())}${p2(dd.getSeconds())}`);
    fs.writeFileSync(logBase + '.json', JSON.stringify({ actedAt: new Date().toISOString(), action: mode, page: PAGE_URL, requested: before, result: report, clickLog: results }, null, 1));
    console.log('操作记录：' + logBase + '.json');
    return;
  }

  if (!NO_LINK) {
    for (const z of rows) {
      try {
        let j = JSON.parse(await ev(mkQr(magic, z.outProductId, z.cpsLink)));
        if (j.httpStatus && /magic/i.test(j.raw || '')) { magic = await getMagic(); j = JSON.parse(await ev(mkQr(magic, z.outProductId, z.cpsLink))); }
        const d = j.img ? decodeQr(j.img, z.productId) : { link: '', why: 'no_img' };
        z.shortLink = d.link; z.qrErr = d.link ? '' : d.why;
      } catch (e) { z.shortLink = ''; z.qrErr = String(e.message || e).slice(0, 100); }
      await sleep(250);
    }
  }

  if (mode === 'list') {
    console.log(`橱窗 ${all.length} 个商品，库存 ≤ ${MAX_STOCK} 命中 ${rows.length} 个\n`);
    rows.forEach((z, i) => console.log(`${String(i + 1).padStart(2)}. [库存 ${z.stock}] ${z.title.slice(0, 34)}　${z.shop}　¥${yuan(z.minPrice)}　${z.shortLink || '(短链未取到)'}`));
    if (!hasZbar && !NO_LINK) console.log('\n提示：没装 zbarimg，取不到商品短链 → brew install zbar');
    return;
  }

  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  // 默认文件名带日期；同一天重复跑自动加序号，绝不覆盖上一次的结果
  let outBase = opt('out', null);
  if (!outBase) {
    const base = path.join(os.homedir(), 'Desktop', `橱窗库存巡检_${stamp}`);
    outBase = base;
    for (let n = 2; fs.existsSync(outBase + '.md'); n++) outBase = `${base}_${n}`;
  } else if (fs.existsSync(outBase + '.md')) {
    console.log('注意：--out 指定的文件已存在，会被覆盖。');
  }
  writeFiles(outBase, { all, rows });
  console.log(`橱窗 ${all.length} 个商品，库存 ≤ ${MAX_STOCK} 命中 ${rows.length} 个`);
  rows.forEach(z => console.log(`  [库存 ${z.stock}] ${z.title.slice(0, 30)}　${z.shortLink || '(短链未取到)'}`));
  console.log('\n输出：\n  ' + outBase + '.md\n  ' + outBase + '.csv\n  ' + outBase + '.json');
  if (!hasZbar) console.log('\n提示：没装 zbarimg，商品短链没取到 → brew install zbar 后重跑');
}

main().catch(e => { console.error('FAIL ' + (e.message || e)); process.exit(1); });
