# DPCCA 部署说明（统一规范）

> **目标**：线上只保留「一套静态托管站点」，文件一律位于托管**根路径**（`/`）。
> **背景**：曾因整目录上传出现两条线上路径（根路径站点 + `/Dpcca/` 二级副本），2026-09-07 已删除云端 `Dpcca/` 副本。今后禁止再产生任何二级副本目录。
> **适用范围**：`Dpcca/` 前端 → CloudBase 静态托管；云函数/数据库变更见第 5 节。

## 1. 站点与环境信息

| 项 | 值 |
| --- | --- |
| CloudBase 环境 ID | `dpcca-wiki-d7g0dl19y23cd30f3` |
| AppID | `1466587016` |
| 静态托管共享域名 | `https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com` |
| 首页文档 | `index.html`（已配置为默认文档） |
| 数据集合 | `anime_library` / `user_anime` / `user_profiles` / `room_sessions` / `site_config`（页面直连只读，不占静态托管） |

线上页面一览（全部在根路径）：

- `/`（`index.html`，追番评分库）
- `/rating.html`（多人联合评分室）
- `/profile.html`（我的追番清单）
- `/admin.html`（番剧管理后台）

## 2. 唯一路径原则（最高优先级）

1. 所有要上线的文件一律上传到托管**根路径**，`cloudPath` **不带任何前缀**，例如 `rating.html`，而不是 `Dpcca/rating.html`。
2. **严禁**整体上传本地 `Dpcca/` 目录；严禁以任何新名字（`Dpcca/`、`dpcca/`、`site/`…）在云端再建一份页面副本。
3. 页面内资源使用**同层相对引用**：`auth.js?v=N`、`reviewwall.js?v=N`、`feedback.js?v=N`、`announcement.js?v=N`、`covers/…`，均以根路径为基准解析；页面内置封面 URL 一律为 `<域名>/covers/…`。
4. 页面脚本引用了带版本号的 JS（`auth.js?v=5|6`、`reviewwall.js?v=5`、`feedback.js?v=4`、`announcement.js?v=1`）：改动对应 `.js` 本体时，若线上同名文件需要同步，一并上传，保持本地 = 线上。

## 3. 源码 → 线上文件映射

| 本地文件（`Dpcca/`） | 上传目标 `cloudPath` | 说明 |
| --- | --- | --- |
| `index.html` / `rating.html` / `profile.html` / `admin.html` | 同名根文件（如 `index.html`） | 主页面 |
| `auth.js` | `auth.js` | index / rating / profile 引用 |
| `reviewwall.js` | `reviewwall.js` | index / profile 引用 |
| `feedback.js` | `feedback.js` | index 引用（反馈入口组件） |
| `announcement.js` | `announcement.js` | index / rating / profile 引用（v2.1 公告弹窗）；admin.html 引用仅为「预览」 |
| 封面图 | `covers/<季度>/aNNNN.jpg` 或 `covers/xxx.jpg` | 与页面 `cover` URL 尾部路径**完全一致** |
| `db-template.html` / `server.js` / `_backup_20260904/` / `202607/` | 不部署 | 本地模板 / 本地预览服务器 / 备份 / 本地素材；仅素材更新时才单独上传对应文件 |
| `README.md` | 可选同步到 `README.md` | 仅在需要更新线上说明时 |

## 4. 标准部署流程

> 方式：**逐文件精准上传**（推荐），杜绝整目录上传造成的副本路径。

**改动页面或 JS 时**

1. 本地编辑完成（可先 `node server.js` 本地预览）。
2. 用 CloudBase **静态托管上传**，将改动文件逐个上传到上表对应 `cloudPath`（根路径，无前缀）。
3. 若同时改了多个文件（如 HTML 与 `auth.js`），用多文件列表一次传齐，避免页面引用到旧 JS。
4. 部署后验证（见第 6 节）。

**新增 / 更换封面图时**

1. 封面图按计划上传到 `covers/<季度>/…`（云端已有同季度目录结构，按季归档）。
2. 把该图完整 URL（或与域名拼接后的路径）填到对应页面的 `cover` 字段。
3. 重新上传对应 HTML，再验证。

## 5. 云函数与数据库（另走独立流程）

- **云函数源码**位于 `cloudfunctions/`：`admin_login`、`dpcca_auth`、`reviews_api`、`anime-api-src`。仅在函数逻辑变化时才单独部署（部署工具按函数名）。
- `admin_login` 同时承载站点级配置读写：`action=configGet` / `action=configSave`（v2.1 公告弹窗，集合 `site_config` 单文档 `announcement`）。该集合规则应为 `read=true / write=false`（所有人可读、仅管理端可写），前台 `announcement.js` 只读，写入仅经云函数。
- **数据库变更（结构 / 批量写入 / 替换 / 内容清理）**：必须先向所有者说明方案并获确认后才能执行；本工作流不得在未确认情况下直接改动集合数据。页面纯前端部署不触碰数据库。
- 静态托管部署不涉及 `__auth/`、`cloud-admin/` 等目录，**不要上传、删除或覆盖**这些目录下的文件。

## 6. 部署后验证清单

以 PowerShell 为例（域名按需替换变量）：

```powershell
$b = "https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com"
curl.exe -s -o NUL -w "/            -> %{http_code}`n" "$b/"
curl.exe -s -o NUL -w "/index.html  -> %{http_code}`n" "$b/index.html"
curl.exe -s -o NUL -w "/rating.html -> %{http_code}`n" "$b/rating.html"
curl.exe -s -o NUL -w "/profile.html-> %{http_code}`n" "$b/profile.html"
curl.exe -s -o NUL -w "/admin.html  -> %{http_code}`n" "$b/admin.html"
curl.exe -s -o NUL -w "/Dpcca/..    -> %{http_code} (应为404)`n" "$b/Dpcca/rating.html"
curl.exe -s -o NUL -w "/announcement.js -> %{http_code}`n" "$b/announcement.js"
```

- 核心页面应全部 **200**；`/Dpcca/…` 应 **404**（确保没再造副本）。
- 抽查改动的资源：`curl -s "$b/rating.html" | Select-String "v=6"` 等确认引用已更新；JS 改动可对 `auth.js` 抓取比对内容。

## 7. 注意事项（踩坑记录）

- 上传是逐文件的；`__auth/`、`cloud-admin/`、`covers/`、`202607/` 等远端目录里的既有文件不要整目录清空或重传覆盖（除非明确要更新其中素材）。
- 批量上传注意静态托管管控接口频控，文件多时分批、留间隔，不要并发突突。
- 共享域名默认有 CDN 缓存，改完想立即看效果可 URL 后加 `?v=` 或稍等刷新；页面引用加版本号参数时务必同步更新被引用的 JS 本体。
- 当前已统一走静态托管共享域名（`*.tcloudbaseapp.com`）。不要擅自切换到 `manageApps` 的独立子域名（`*.webapps.tcloudbase.com`），会生成全新 URL、导致既有分享链接失效；除非所有者明确要求迁移。

> 维护：本文档为「以后部署默认遵守」的规范。任何与第 2 节相悖的操作均需先与所有者确认。
