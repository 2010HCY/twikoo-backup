import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import md5 from 'js-md5'
import indexHtml from './index.html'

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
async function sha256(str: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(buf =>
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

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const adminPasswordHash = await sha256(env.ADMIN_PASSWORD || "admin");
    const cookieExpiresDays = parseInt(env.COOKIE_EXPIRES_DAYS || "7");

    // 登录页面
    if (
      url.pathname === "/login" ||
      url.pathname === "/login.html"
    ) {
      return env.ASSETS.fetch(req);
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
    if (
      url.pathname === "/" ||
      url.pathname === "/index.html"
    ) {
      const token = getTokenFromRequest(req);
      const isValid = await verifyToken(token, adminPasswordHash);
      if (!isValid) {
        // 重定向到登录页
        return Response.redirect(new URL("/login", req.url).toString(), 302);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(indexHtml, {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
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