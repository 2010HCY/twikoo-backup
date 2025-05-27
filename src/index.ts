import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import md5 from 'js-md5'

type Env = {
  DB: D1Database
  TWIKOO_COMMENT_BACKUP: Workflow
  TWIKOO_URL: string
  TWIKOO_PASSWORD: string
  BACKUP_KEEP_DAYS: string
  ADMIN_PASSWORD: string
  COOKIE_EXPIRES_DAYS: string
}

function logEvent(event: string, data: any = {}, req?: Request) {
  const now = new Date().toISOString()
  const ipStr = req?.headers.get("cf-connecting-ip")
  const uaStr = req?.headers.get("user-agent")
  const extras =
    (ipStr ? " ip=" + ipStr : "") +
    (uaStr ? " ua=" + uaStr : "")
  console.log(`[${now}] [${event}] ${JSON.stringify(data)}${extras}`)
}

// WORKFLOW备份
export class TwikooCommentBackupWorkflow extends WorkflowEntrypoint<Env, {}> {
  async run(event: WorkflowEvent<{}, Env>, step: WorkflowStep) {
    const { DB, TWIKOO_URL, TWIKOO_PASSWORD, BACKUP_KEEP_DAYS } = this.env
    const keepDays = parseInt(BACKUP_KEEP_DAYS) || 3
    const dateStr = new Date().toISOString().slice(0, 10)
    const md5Password = await md5(TWIKOO_PASSWORD)

    try {
      // 1. 拉取评论
      const comments = await step.do("fetch comments", async () => {
        const body = {
          accessToken: md5Password,
          collection: "comment",
          event: "COMMENT_EXPORT_FOR_ADMIN"
        }
        let res: Response
        try {
          res = await fetch(TWIKOO_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          })
        } catch (err: any) {
          throw new Error(`fetch twikoo失败: ${err?.message || JSON.stringify(err)}`)
        }
        if (!res.ok) {
          const text = await res.text()
          throw new Error(`Twikoo API Http错误: ${res.status} ${res.statusText} body: ${text}`)
        }
        let data: any
        try {
          data = await res.json()
        } catch {
          const text = await res.text()
          throw new Error(`Twikoo接口不是json，body: ${text}`)
        }
        if (data.code !== 0) {
          throw new Error(`Twikoo接口报错: code=${data.code}, message=${data.message}`)
        }
        return data.data
      })

      // 2. 写D1
      await step.do("save to D1", async () => {
        await DB.prepare(
          `INSERT INTO comments_backup (date, content) VALUES (?, ?)`
        ).bind(dateStr, JSON.stringify(comments)).run()
      })
      // 3. 自动删老备份
      await step.do("clean D1", async () => {
      await DB.prepare(`
        DELETE FROM comments_backup
        WHERE id NOT IN (
          SELECT id FROM comments_backup
          ORDER BY id DESC
          LIMIT ?
        )
      `).bind(keepDays).run();
      })
      logEvent("auto_backup", { success: true, date: dateStr })
      return { status: "success", date: dateStr, savedRows: 1 }
    } catch (e: any) {
      logEvent("auto_backup", { success: false, error: String(e), date: dateStr })
      throw e
    }
  }
}

// 辅助函数
function md5(str: string) {
  return crypto.subtle.digest("MD5", new TextEncoder().encode(str)).then(buf =>
    Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("")
  )
}
function getKeepStartDateStr(today: Date, keepDays: number) {
  const oldest = new Date(today)
  oldest.setDate(oldest.getDate() - (keepDays - 1))
  return oldest.toISOString().slice(0, 10)
}

async function verifyToken(token: string, expectedHash: string): Promise<boolean> {
  return token === expectedHash;
}

function getTokenFromRequest(req: Request): string | null {
  const cookies = req.headers.get('cookie');
  if (!cookies) return null;
  const cookieParts = cookies.split(';').map(part => part.trim());
  for (const part of cookieParts) {
    if (part.startsWith('auth_token=')) {
      return part.substring('auth_token='.length);
    }
  }
  return null;
}

const htmlPage = /*html*/ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Twikoo评论备份面板</title>
  <style>
    body { font-family:sans-serif; background:#f5f6fa; color:#222; background-color: oklch(0.95 0.025 112) }
    #main { max-width:560px; margin:60px auto; background:#fff; border-radius:20px; box-shadow:0 1px 8px #9992; padding:42px 32px 32px 32px; }
    .center { text-align:center; }
    button {
      padding: 12px 44px; background: #a3a300; color:#fff; border-radius: 8px;
      border: none; font-size: 1.2em; margin-bottom: 12px; cursor: pointer;
      transition: background 0.2s;
    }
    button[disabled] { background: #c6c60a; cursor:not-allowed; }
    .status { height:20px; margin-bottom:30px; min-height:24px; font-size: 1em; }
    .rectangle { background: #f2f3f7; border-radius: 12px; margin-top:30px; padding: 22px 20px; }
    .rowlist { margin:0; padding:0; list-style:none; }
    .rowlist li {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0; border-bottom: 1px solid #ececec; font-size:1.1em;
    }
    .rowlist li:last-child { border-bottom:none; }
    .id { font-size:1.2em; }
    .date { margin-left:6px; color: #353; }
    .dlbtn {
      background: #7a9f13; color: #fff; text-decoration:none;border: none; border-radius: 6px; padding: 6px 16px;
      cursor: pointer; font-size:1em;
    }
  </style>
</head>
<body>
<div id="main">
  <div class="center">
    <button id="backupBtn">开始备份</button>
    <div class="status" id="statusMsg"></div>
  </div>
  <div class="rectangle">
    <h3 style="margin-top:0.2em">历史备份</h3>
    <ul id="rows" class="rowlist"></ul>
    <div id="nodata" style="color:#888; text-align:center; margin-top:16px; display:none;">暂无备份</div>
  </div>
</div>
<script>
const listUrl = location.pathname + "list";
const downloadBase = location.pathname + "download/";
const backupUrl = location.pathname + "backup"; 

const $ = id => document.getElementById(id);
function showStatus(msg, color) {
  $('statusMsg').textContent = msg;
  $('statusMsg').style.color = color || '#222';
}
async function loadList() {
  const r = await fetch(listUrl);
  const arr = await r.json();
  const ul = $('rows');
  ul.innerHTML = '';
  if (!arr || arr.length == 0) {
    $('nodata').style.display = '';
    return;
  }
  $('nodata').style.display = 'none';
  arr.forEach((row, i) => {
    const li = document.createElement('li');
    let kb = (row.size / 1024).toFixed(1);
    li.innerHTML =
      '<span class="id">#' + (i+1) + '</span>' +
      '<span class="date">' + row.date + '</span>' +
      '<span class="filesize" style="margin-left:8px;color:#888;">(' + kb + 'KB)</span>' +
      '<a class="dlbtn" href="' + downloadBase + row.id + '" download="twikoo-comment-' + row.date + '.json" target="_blank">下载</a>';
    ul.appendChild(li);
  });
}

$('backupBtn').onclick = async function() {
  this.disabled = true;
  showStatus("正在备份...", "#4e8cff");
  try {
    const resp = await fetch(backupUrl, { method: "POST" });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    if (data.msg && data.msg.match(/已启动/)) {
      showStatus("备份启动，稍等刷新...", "#222");
      setTimeout(async () => {
        await loadList();
        showStatus("备份完成！","#258c34");
        setTimeout(()=>showStatus(''),1600);
      }, 3500);
    } else {
      showStatus("启动失败: "+JSON.stringify(data), "#d8000c");
      $('backupBtn').disabled = false;
    }
  } catch(e) {
    showStatus("备份出错："+e.message, "#d8000c");
    $('backupBtn').disabled = false;
  }
};

window.onload = loadList;
</script>
</body>
</html>
`;

const loginPage = /*html*/ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Twikoo评论备份面板 - 登录</title>
  <style>
    body { font-family:sans-serif; background:#f5f6fa; color:#222; background-color: oklch(0.95 0.025 112) }
    #main { max-width:400px; margin:60px auto; background:#fff; border-radius:20px; box-shadow:0 1px 8px #9992; padding:42px 32px 32px 32px; }
    .center { text-align:center; }
    input {
      width: 100%;
      padding: 10px;
      margin-bottom: 20px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1.1em;
      box-sizing: border-box;
    }
    button {
      padding: 12px 44px; background: #a3a300; color:#fff; border-radius: 8px;
      border: none; font-size: 1.2em; margin-bottom: 12px; cursor: pointer;
      transition: background 0.2s;
    }
    button[disabled] { background: #c6c60a; cursor:not-allowed; }
    .status { height:20px; margin-bottom:30px; min-height:24px; font-size: 1em; }
  </style>
  <script>!function(){"use strict";var t="input is invalid type",r="object"==typeof window,e=r?window:{};e.JS_MD5_NO_WINDOW&&(r=!1);var i=!r&&"object"==typeof self,s=!e.JS_MD5_NO_NODE_JS&&"object"==typeof process&&process.versions&&process.versions.node;s?e=global:i&&(e=self);var h,n=!e.JS_MD5_NO_COMMON_JS&&"object"==typeof module&&module.exports,o="function"==typeof define&&define.amd,a=!e.JS_MD5_NO_ARRAY_BUFFER&&"undefined"!=typeof ArrayBuffer,f="0123456789abcdef".split(""),u=[128,32768,8388608,-2147483648],c=[0,8,16,24],y=["hex","array","digest","buffer","arrayBuffer","base64"],p="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split(""),d=[];if(a){var l=new ArrayBuffer(68);h=new Uint8Array(l),d=new Uint32Array(l)}var b=Array.isArray;!e.JS_MD5_NO_NODE_JS&&b||(b=function(t){return"[object Array]"===Object.prototype.toString.call(t)});var v=ArrayBuffer.isView;!a||!e.JS_MD5_NO_ARRAY_BUFFER_IS_VIEW&&v||(v=function(t){return"object"==typeof t&&t.buffer&&t.buffer.constructor===ArrayBuffer});var w=function(r){var e=typeof r;if("string"===e)return[r,!0];if("object"!==e||null===r)throw new Error(t);if(a&&r.constructor===ArrayBuffer)return[new Uint8Array(r),!1];if(!b(r)&&!v(r))throw new Error(t);return[r,!1]},A=function(t){return function(r){return new g(!0).update(r)[t]()}},_=function(r){var i,s=require("crypto"),h=require("buffer").Buffer;i=h.from&&!e.JS_MD5_NO_BUFFER_FROM?h.from:function(t){return new h(t)};return function(e){if("string"==typeof e)return s.createHash("md5").update(e,"utf8").digest("hex");if(null==e)throw new Error(t);return e.constructor===ArrayBuffer&&(e=new Uint8Array(e)),b(e)||v(e)||e.constructor===h?s.createHash("md5").update(i(e)).digest("hex"):r(e)}},B=function(t){return function(r,e){return new m(r,!0).update(e)[t]()}};function g(t){if(t)d[0]=d[16]=d[1]=d[2]=d[3]=d[4]=d[5]=d[6]=d[7]=d[8]=d[9]=d[10]=d[11]=d[12]=d[13]=d[14]=d[15]=0,this.blocks=d,this.buffer8=h;else if(a){var r=new ArrayBuffer(68);this.buffer8=new Uint8Array(r),this.blocks=new Uint32Array(r)}else this.blocks=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];this.h0=this.h1=this.h2=this.h3=this.start=this.bytes=this.hBytes=0,this.finalized=this.hashed=!1,this.first=!0}function m(t,r){var e,i=w(t);if(t=i[0],i[1]){var s,h=[],n=t.length,o=0;for(e=0;e<n;++e)(s=t.charCodeAt(e))<128?h[o++]=s:s<2048?(h[o++]=192|s>>>6,h[o++]=128|63&s):s<55296||s>=57344?(h[o++]=224|s>>>12,h[o++]=128|s>>>6&63,h[o++]=128|63&s):(s=65536+((1023&s)<<10|1023&t.charCodeAt(++e)),h[o++]=240|s>>>18,h[o++]=128|s>>>12&63,h[o++]=128|s>>>6&63,h[o++]=128|63&s);t=h}t.length>64&&(t=new g(!0).update(t).array());var a=[],f=[];for(e=0;e<64;++e){var u=t[e]||0;a[e]=92^u,f[e]=54^u}g.call(this,r),this.update(f),this.oKeyPad=a,this.inner=!0,this.sharedMemory=r}g.prototype.update=function(t){if(this.finalized)throw new Error("finalize already called");var r=w(t);t=r[0];for(var e,i,s=r[1],h=0,n=t.length,o=this.blocks,f=this.buffer8;h<n;){if(this.hashed&&(this.hashed=!1,o[0]=o[16],o[16]=o[1]=o[2]=o[3]=o[4]=o[5]=o[6]=o[7]=o[8]=o[9]=o[10]=o[11]=o[12]=o[13]=o[14]=o[15]=0),s)if(a)for(i=this.start;h<n&&i<64;++h)(e=t.charCodeAt(h))<128?f[i++]=e:e<2048?(f[i++]=192|e>>>6,f[i++]=128|63&e):e<55296||e>=57344?(f[i++]=224|e>>>12,f[i++]=128|e>>>6&63,f[i++]=128|63&e):(e=65536+((1023&e)<<10|1023&t.charCodeAt(++h)),f[i++]=240|e>>>18,f[i++]=128|e>>>12&63,f[i++]=128|e>>>6&63,f[i++]=128|63&e);else for(i=this.start;h<n&&i<64;++h)(e=t.charCodeAt(h))<128?o[i>>>2]|=e<<c[3&i++]:e<2048?(o[i>>>2]|=(192|e>>>6)<<c[3&i++],o[i>>>2]|=(128|63&e)<<c[3&i++]):e<55296||e>=57344?(o[i>>>2]|=(224|e>>>12)<<c[3&i++],o[i>>>2]|=(128|e>>>6&63)<<c[3&i++],o[i>>>2]|=(128|63&e)<<c[3&i++]):(e=65536+((1023&e)<<10|1023&t.charCodeAt(++h)),o[i>>>2]|=(240|e>>>18)<<c[3&i++],o[i>>>2]|=(128|e>>>12&63)<<c[3&i++],o[i>>>2]|=(128|e>>>6&63)<<c[3&i++],o[i>>>2]|=(128|63&e)<<c[3&i++]);else if(a)for(i=this.start;h<n&&i<64;++h)f[i++]=t[h];else for(i=this.start;h<n&&i<64;++h)o[i>>>2]|=t[h]<<c[3&i++];this.lastByteIndex=i,this.bytes+=i-this.start,i>=64?(this.start=i-64,this.hash(),this.hashed=!0):this.start=i}return this.bytes>4294967295&&(this.hBytes+=this.bytes/4294967296<<0,this.bytes=this.bytes%4294967296),this},g.prototype.finalize=function(){if(!this.finalized){this.finalized=!0;var t=this.blocks,r=this.lastByteIndex;t[r>>>2]|=u[3&r],r>=56&&(this.hashed||this.hash(),t[0]=t[16],t[16]=t[1]=t[2]=t[3]=t[4]=t[5]=t[6]=t[7]=t[8]=t[9]=t[10]=t[11]=t[12]=t[13]=t[14]=t[15]=0),t[14]=this.bytes<<3,t[15]=this.hBytes<<3|this.bytes>>>29,this.hash()}},g.prototype.hash=function(){var t,r,e,i,s,h,n=this.blocks;this.first?r=((r=((t=((t=n[0]-680876937)<<7|t>>>25)-271733879<<0)^(e=((e=(-271733879^(i=((i=(-1732584194^2004318071&t)+n[1]-117830708)<<12|i>>>20)+t<<0)&(-271733879^t))+n[2]-1126478375)<<17|e>>>15)+i<<0)&(i^t))+n[3]-1316259209)<<22|r>>>10)+e<<0:(t=this.h0,r=this.h1,e=this.h2,r=((r+=((t=((t+=((i=this.h3)^r&(e^i))+n[0]-680876936)<<7|t>>>25)+r<<0)^(e=((e+=(r^(i=((i+=(e^t&(r^e))+n[1]-389564586)<<12|i>>>20)+t<<0)&(t^r))+n[2]+606105819)<<17|e>>>15)+i<<0)&(i^t))+n[3]-1044525330)<<22|r>>>10)+e<<0),r=((r+=((t=((t+=(i^r&(e^i))+n[4]-176418897)<<7|t>>>25)+r<<0)^(e=((e+=(r^(i=((i+=(e^t&(r^e))+n[5]+1200080426)<<12|i>>>20)+t<<0)&(t^r))+n[6]-1473231341)<<17|e>>>15)+i<<0)&(i^t))+n[7]-45705983)<<22|r>>>10)+e<<0,r=((r+=((t=((t+=(i^r&(e^i))+n[8]+1770035416)<<7|t>>>25)+r<<0)^(e=((e+=(r^(i=((i+=(e^t&(r^e))+n[9]-1958414417)<<12|i>>>20)+t<<0)&(t^r))+n[10]-42063)<<17|e>>>15)+i<<0)&(i^t))+n[11]-1990404162)<<22|r>>>10)+e<<0,r=((r+=((t=((t+=(i^r&(e^i))+n[12]+1804603682)<<7|t>>>25)+r<<0)^(e=((e+=(r^(i=((i+=(e^t&(r^e))+n[13]-40341101)<<12|i>>>20)+t<<0)&(t^r))+n[14]-1502002290)<<17|e>>>15)+i<<0)&(i^t))+n[15]+1236535329)<<22|r>>>10)+e<<0,r=((r+=((i=((i+=(r^e&((t=((t+=(e^i&(r^e))+n[1]-165796510)<<5|t>>>27)+r<<0)^r))+n[6]-1069501632)<<9|i>>>23)+t<<0)^t&((e=((e+=(t^r&(i^t))+n[11]+643717713)<<14|e>>>18)+i<<0)^i))+n[0]-373897302)<<20|r>>>12)+e<<0,r=((r+=((i=((i+=(r^e&((t=((t+=(e^i&(r^e))+n[5]-701558691)<<5|t>>>27)+r<<0)^r))+n[10]+38016083)<<9|i>>>23)+t<<0)^t&((e=((e+=(t^r&(i^t))+n[15]-660478335)<<14|e>>>18)+i<<0)^i))+n[4]-405537848)<<20|r>>>12)+e<<0,r=((r+=((i=((i+=(r^e&((t=((t+=(e^i&(r^e))+n[9]+568446438)<<5|t>>>27)+r<<0)^r))+n[14]-1019803690)<<9|i>>>23)+t<<0)^t&((e=((e+=(t^r&(i^t))+n[3]-187363961)<<14|e>>>18)+i<<0)^i))+n[8]+1163531501)<<20|r>>>12)+e<<0,r=((r+=((i=((i+=(r^e&((t=((t+=(e^i&(r^e))+n[13]-1444681467)<<5|t>>>27)+r<<0)^r))+n[2]-51403784)<<9|i>>>23)+t<<0)^t&((e=((e+=(t^r&(i^t))+n[7]+1735328473)<<14|e>>>18)+i<<0)^i))+n[12]-1926607734)<<20|r>>>12)+e<<0,r=((r+=((h=(i=((i+=((s=r^e)^(t=((t+=(s^i)+n[5]-378558)<<4|t>>>28)+r<<0))+n[8]-2022574463)<<11|i>>>21)+t<<0)^t)^(e=((e+=(h^r)+n[11]+1839030562)<<16|e>>>16)+i<<0))+n[14]-35309556)<<23|r>>>9)+e<<0,r=((r+=((h=(i=((i+=((s=r^e)^(t=((t+=(s^i)+n[1]-1530992060)<<4|t>>>28)+r<<0))+n[4]+1272893353)<<11|i>>>21)+t<<0)^t)^(e=((e+=(h^r)+n[7]-155497632)<<16|e>>>16)+i<<0))+n[10]-1094730640)<<23|r>>>9)+e<<0,r=((r+=((h=(i=((i+=((s=r^e)^(t=((t+=(s^i)+n[13]+681279174)<<4|t>>>28)+r<<0))+n[0]-358537222)<<11|i>>>21)+t<<0)^t)^(e=((e+=(h^r)+n[3]-722521979)<<16|e>>>16)+i<<0))+n[6]+76029189)<<23|r>>>9)+e<<0,r=((r+=((h=(i=((i+=((s=r^e)^(t=((t+=(s^i)+n[9]-640364487)<<4|t>>>28)+r<<0))+n[12]-421815835)<<11|i>>>21)+t<<0)^t)^(e=((e+=(h^r)+n[15]+530742520)<<16|e>>>16)+i<<0))+n[2]-995338651)<<23|r>>>9)+e<<0,r=((r+=((i=((i+=(r^((t=((t+=(e^(r|~i))+n[0]-198630844)<<6|t>>>26)+r<<0)|~e))+n[7]+1126891415)<<10|i>>>22)+t<<0)^((e=((e+=(t^(i|~r))+n[14]-1416354905)<<15|e>>>17)+i<<0)|~t))+n[5]-57434055)<<21|r>>>11)+e<<0,r=((r+=((i=((i+=(r^((t=((t+=(e^(r|~i))+n[12]+1700485571)<<6|t>>>26)+r<<0)|~e))+n[3]-1894986606)<<10|i>>>22)+t<<0)^((e=((e+=(t^(i|~r))+n[10]-1051523)<<15|e>>>17)+i<<0)|~t))+n[1]-2054922799)<<21|r>>>11)+e<<0,r=((r+=((i=((i+=(r^((t=((t+=(e^(r|~i))+n[8]+1873313359)<<6|t>>>26)+r<<0)|~e))+n[15]-30611744)<<10|i>>>22)+t<<0)^((e=((e+=(t^(i|~r))+n[6]-1560198380)<<15|e>>>17)+i<<0)|~t))+n[13]+1309151649)<<21|r>>>11)+e<<0,r=((r+=((i=((i+=(r^((t=((t+=(e^(r|~i))+n[4]-145523070)<<6|t>>>26)+r<<0)|~e))+n[11]-1120210379)<<10|i>>>22)+t<<0)^((e=((e+=(t^(i|~r))+n[2]+718787259)<<15|e>>>17)+i<<0)|~t))+n[9]-343485551)<<21|r>>>11)+e<<0,this.first?(this.h0=t+1732584193<<0,this.h1=r-271733879<<0,this.h2=e-1732584194<<0,this.h3=i+271733878<<0,this.first=!1):(this.h0=this.h0+t<<0,this.h1=this.h1+r<<0,this.h2=this.h2+e<<0,this.h3=this.h3+i<<0)},g.prototype.hex=function(){this.finalize();var t=this.h0,r=this.h1,e=this.h2,i=this.h3;return f[t>>>4&15]+f[15&t]+f[t>>>12&15]+f[t>>>8&15]+f[t>>>20&15]+f[t>>>16&15]+f[t>>>28&15]+f[t>>>24&15]+f[r>>>4&15]+f[15&r]+f[r>>>12&15]+f[r>>>8&15]+f[r>>>20&15]+f[r>>>16&15]+f[r>>>28&15]+f[r>>>24&15]+f[e>>>4&15]+f[15&e]+f[e>>>12&15]+f[e>>>8&15]+f[e>>>20&15]+f[e>>>16&15]+f[e>>>28&15]+f[e>>>24&15]+f[i>>>4&15]+f[15&i]+f[i>>>12&15]+f[i>>>8&15]+f[i>>>20&15]+f[i>>>16&15]+f[i>>>28&15]+f[i>>>24&15]},g.prototype.toString=g.prototype.hex,g.prototype.digest=function(){this.finalize();var t=this.h0,r=this.h1,e=this.h2,i=this.h3;return[255&t,t>>>8&255,t>>>16&255,t>>>24&255,255&r,r>>>8&255,r>>>16&255,r>>>24&255,255&e,e>>>8&255,e>>>16&255,e>>>24&255,255&i,i>>>8&255,i>>>16&255,i>>>24&255]},g.prototype.array=g.prototype.digest,g.prototype.arrayBuffer=function(){this.finalize();var t=new ArrayBuffer(16),r=new Uint32Array(t);return r[0]=this.h0,r[1]=this.h1,r[2]=this.h2,r[3]=this.h3,t},g.prototype.buffer=g.prototype.arrayBuffer,g.prototype.base64=function(){for(var t,r,e,i="",s=this.array(),h=0;h<15;)t=s[h++],r=s[h++],e=s[h++],i+=p[t>>>2]+p[63&(t<<4|r>>>4)]+p[63&(r<<2|e>>>6)]+p[63&e];return t=s[h],i+=p[t>>>2]+p[t<<4&63]+"=="},m.prototype=new g,m.prototype.finalize=function(){if(g.prototype.finalize.call(this),this.inner){this.inner=!1;var t=this.array();g.call(this,this.sharedMemory),this.update(this.oKeyPad),this.update(t),g.prototype.finalize.call(this)}};var O=function(){var t=A("hex");s&&(t=_(t)),t.create=function(){return new g},t.update=function(r){return t.create().update(r)};for(var r=0;r<y.length;++r){var e=y[r];t[e]=A(e)}return t}();O.md5=O,O.md5.hmac=function(){var t=B("hex");t.create=function(t){return new m(t)},t.update=function(r,e){return t.create(r).update(e)};for(var r=0;r<y.length;++r){var e=y[r];t[e]=B(e)}return t}(),n?module.exports=O:(e.md5=O,o&&define((function(){return O})))}();</script>
</head>
<body>
<div id="main">
  <h2 class="center">Twikoo评论备份面板</h2>
  <div class="center">
    <input type="password" id="passwordInput" placeholder="请输入管理密码" />
    <button id="loginBtn">登录</button>
    <div class="status" id="statusMsg"></div>
  </div>
</div>
<script>
function showStatus(msg, color) {
  document.getElementById('statusMsg').textContent = msg;
  document.getElementById('statusMsg').style.color = color || '#222';
}

function setCookie(name, value, exdays) {
  let expires = "";
  if (exdays !== 0) {
    const d = new Date();
    d.setTime(d.getTime() + (exdays * 24 * 60 * 60 * 1000));
    expires = "expires=" + d.toUTCString();
  }
  document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

document.getElementById('loginBtn').onclick = function() {
  const password = document.getElementById('passwordInput').value;
  if (!password) {
    showStatus("请输入密码", "#d8000c");
    return;
  }
  
  this.disabled = true;
  showStatus("验证中...", "#4e8cff");
  
  try {
    const passwordHash = md5(password);
    fetch("verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: passwordHash })
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        showStatus("验证成功，正在跳转...", "#258c34");
        setCookie("auth_token", passwordHash, data.expiresInDays);
        setTimeout(() => {
          window.location.href = "/";
        }, 1000);
      } else {
        showStatus("密码错误", "#d8000c");
        document.getElementById('loginBtn').disabled = false;
      }
    })
    .catch(e => {
      showStatus("验证出错：" + e.message, "#d8000c");
      document.getElementById('loginBtn').disabled = false;
    });
  } catch(e) {
    showStatus("验证出错：" + e.message, "#d8000c");
    this.disabled = false;
  }
};

// 按回车键登录
document.getElementById('passwordInput').addEventListener('keypress', function(e) {
  if (e.key === 'Enter') {
    document.getElementById('loginBtn').click();
  }
});
</script>
</body>
</html>
`;

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const adminPasswordHash = await md5(env.ADMIN_PASSWORD || "admin");
    const cookieExpiresDays = parseInt(env.COOKIE_EXPIRES_DAYS || "7");

    // 登录页面
    if (url.pathname === "/login") {
      logEvent("login_page_view", {}, req);
      return new Response(loginPage, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 验证密码
    if (url.pathname === "/verify" && req.method === "POST") {
      try {
        const { hash } = await req.json();
        const isValid = await verifyToken(hash, adminPasswordHash);
        logEvent("login_attempt", { success: isValid }, req);
        return Response.json({ 
          success: isValid, 
          expiresInDays: cookieExpiresDays 
        });
      } catch (e) {
        logEvent("login_error", { error: String(e) }, req);
        return Response.json({ success: false, error: "Invalid request" }, { status: 400 });
      }
    }

    // 主页
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const token = getTokenFromRequest(req);
      const isValid = await verifyToken(token, adminPasswordHash);
      
      if (!isValid) {
        // 重定向到登录页面
        return new Response("", {
          status: 302,
          headers: { "Location": "/login" }
        });
      }
      
      logEvent("page_view", {}, req);
      return new Response(htmlPage, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 查询列表
    if (url.pathname.endsWith("/list") && req.method === "GET") {
      const token = getTokenFromRequest(req);
      const isValid = await verifyToken(token, adminPasswordHash);
      
      if (!isValid) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const { results } = await env.DB.prepare(
        `SELECT id, date, LENGTH(content) AS size FROM comments_backup ORDER BY id DESC`
      ).all();
      return Response.json(results);
    }

    // 下载
    if (url.pathname.startsWith("/download/")) {
      const token = getTokenFromRequest(req);
      const isValid = await verifyToken(token, adminPasswordHash);
      
      if (!isValid) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const id = url.pathname.split("/download/")[1];
      let row = await env.DB.prepare(`SELECT content, date FROM comments_backup WHERE id = ?`).bind(id).first();
      if (row) {
        logEvent("download_backup", { success:true, id }, req);
        return new Response(row.content, {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="twikoo-comment-${row.date}.json"`
          }
        });
      } else {
        logEvent("download_backup", { success:false, id }, req);
        return new Response("not found", {status:404});
      }
    }

    // 手动备份
    if (req.method === "POST" && url.pathname.endsWith("/backup")) {
      const token = getTokenFromRequest(req);
      const isValid = await verifyToken(token, adminPasswordHash);
      
      if (!isValid) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      try {
        const instance = await env.TWIKOO_COMMENT_BACKUP.create();
        logEvent("manual_backup", { success:true, instanceId: instance.id }, req);
        return Response.json({ msg: "twikoo备份已启动", id: instance.id });
      } catch (e) {
        logEvent("manual_backup", { success:false, error:String(e) }, req);
        return new Response("备份失败", { status:500 });
      }
    }

    return new Response("", { status: 404 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    try {
      // 启动备份实例
      const instance = await env.TWIKOO_COMMENT_BACKUP.create();
      logEvent("cron_backup", { success: true, instanceId: instance.id, cron: controller.cron });
    } catch (e) {
      logEvent("cron_backup", { success: false, error: String(e), cron: controller.cron });
    }
  }
};