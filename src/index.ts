import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'

type Env = {
  DB: D1Database
  TWIKOO_COMMENT_BACKUP: Workflow
  TWIKOO_URL: string
  TWIKOO_PASSWORD: string
  BACKUP_KEEP_DAYS: string
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

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // 主页
    if (url.pathname === "/" || url.pathname === "/index.html") {
      logEvent("page_view", {}, req);
      return new Response(htmlPage, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 查询列表
    if (url.pathname.endsWith("/list") && req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT id, date, LENGTH(content) AS size FROM comments_backup ORDER BY id DESC`
      ).all();
      return Response.json(results);
    }

    // 下载
    if (url.pathname.startsWith("/download/")) {
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