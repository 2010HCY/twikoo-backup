# Twikoo-backup

<img src="./images/页面.png" style="zoom:80%;" />

Twikoo评论数据备份，使用CloudflareWorkers工作流实现自动备份，也可以手动备份，备份数据储存在D1数据库。备份将在每天00：00自动运行。

若Twikoo评论数据出现丢失、恶意污染，你可以在浏览器里一键下载最新备份，下载文件名为`twikoo-comment-备份日期.json`

<img src="./images/备份成功.png" style="zoom:80%;" />

一键部署：
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/2010HCY/twikoo-backup)

变量说明

```
TWIKOO_URL = "https://xxxxx/.netlify/functions/twikoo" #你的Twikoo后端地址
TWIKOO_PASSWORD = "xxxxx"  #你的Twikoo后端密码
BACKUP_KEEP_DAYS = "3" #工作流将保存几份备份
```

