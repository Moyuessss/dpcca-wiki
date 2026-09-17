# DPCCA · 番剧追番 + 多人联合评分双站系统

纯前端 Web 应用 + 腾讯云开发（CloudBase）后端：**单人追番评分库** + **多人联合评分室**双站点，数据存云数据库，支持多设备实时同步。零构建，原生 JavaScript，拿到源码即可自行部署。

## 功能一览

### 单人追番评分库（index.html）

- 季度浏览：按 1 月冬 / 4 月春 / 7 月夏 / 10 月秋季度 Tab 切换番剧
- 多条件筛选：标题 / 类型 / 标签 / 年份 / 月份 / 季度 / 来源，支持多选（空 = 不限）
- 详情弹窗：封面、简介、制作信息、PV 链接按钮
- 三级评分体系：开播评分（首集观感）· 单集评分（每集独立打分）· 完结评分（追完总结）
- 追番状态：在看 / 看完 / 弃番，单集观看进度勾选
- 完结撒花动画特效
- 分享卡片：一键导出「我的季度评分」一图流 PNG（html2canvas）
- 数据持久化：本地 localStorage，登录后自动同步云端
- 评论墙 + 用户反馈入口

### 我的追番清单（profile.html）

- 个人追番 / 评分数据汇总视图，与评分库数据互通
- 同款筛选、详情弹窗、PV 按钮、评论墙

### 多人联合评分室（rating.html）

- 房间系统：创建房间（云端查重）、输入房间号加入、URL `?room=` 邀请链接直达
- 房主可开启**密码锁**（房间数据只存密码摘要，不存明文）与**房间号隐藏**（全员只见 `******`）
- 昵称记忆：昵称存云端，跨设备保持
- 房主权限：配置评分轮次、移除成员、开启评分
- 轮流评分：每人每轮对指定番剧打分，提交后锁定，房主可放行修改
- 实时同步：云端 `watch()` 实时监听房间数据，成员在线状态实时刷新（本地 BroadcastChannel 降级）
- 统计弹窗：实时查看各成员评分进度
- 结果页：排行榜、长图导出（html2canvas）、CSV 导出（含 BOM，Excel 可直接打开）

### 番剧管理后台（admin.html）

- 账号密码登录（凭据由云函数读取环境变量校验，前端无硬编码口令）
- 番剧增删改：标题、季度、类型、标签、简介、制作信息、封面、PV 链接、隐藏关键词等
- 全站公告弹窗配置：启用开关 + 内容编辑 + 实时预览，内容更新后已静默用户会重新看到

## 技术栈

| 依赖 | 说明 |
| --- | --- |
| Tailwind CSS CDN | 原子化样式 |
| Font Awesome 6 CDN | 图标 |
| html2canvas 1.4.1 CDN | 分享卡片 / 排行榜长图导出 |
| @cloudbase/js-sdk 2.32.0 CDN | 腾讯云开发 Web SDK（游客/邮箱账号登录 + 云数据库） |
| 原生 JavaScript | 零构建，双击即用 |

## 本地运行

```bash
node server.js
```

- 单人追番评分库：http://localhost:5173/index.html
- 多人联合评分室：http://localhost:5173/rating.html

`server.js` 为零依赖本地静态服务器，仅使用 Node 内置模块（http / fs / path）。

## 自行部署与数据库配置

整个站点依赖一个腾讯云开发（CloudBase）环境，按以下步骤配置即可完整复现。

### 1. 开通 CloudBase 环境

- 到 [CloudBase 控制台](https://console.cloud.tencent.com/tcb) 创建环境（按量计费有免费额度），记下**环境 ID**
- 在「身份认证 → 登录授权」中开启**匿名登录**（游客模式必需）；如需邮箱注册登录，再开启邮箱登录并配置 SMTP 发件邮箱

### 2. 创建云数据库集合

| 集合 | 用途 | 安全规则 |
| --- | --- | --- |
| `anime_library` | 公共番剧库（含图片封面 `cover`、PV 链接 `pvUrl` 字段） | 读：所有人；写：`false`（仅云函数可写） |
| `user_anime` | 用户追番评分数据，按 uid 隔离 | 读/写：`doc._openid == auth.uid \|\| doc.userId == auth.uid` |
| `user_profiles` | 用户昵称档案 | 读/写：`auth != null`（登录即可） |
| `room_sessions` | 多人评分房间实时数据 | 读/写：`auth != null`（登录即可） |
| `site_config` | 站点级配置（公告弹窗，单文档 `announcement`） | 读：所有人；写：`false`（仅云函数可写） |

> 规则说明：Web 端安全规则无 `auth.openid` 变量，须使用 `auth.uid`（匿名/邮箱账号的 uid）。

### 3. 替换前端代码中的环境 ID

以下 5 个文件各有一处 `ENV_ID` 常量，全部替换为你自己的环境 ID：

- `Dpcca/index.html`（`dataProvider.ENV_ID`）
- `Dpcca/profile.html`（`dataProvider.ENV_ID`）
- `Dpcca/rating.html`（`dataProvider.ENV_ID`）
- `Dpcca/admin.html`（`const ENV_ID`）
- `Dpcca/db-template.html`（两处 `const ENV_ID`）

### 4. 部署云函数

`cloudfunctions/` 下每个子目录是一个云函数，逐个在 CloudBase 控制台创建并上传：

| 云函数 | 用途 |
| --- | --- |
| `admin_login` | 管理后台登录校验 + 番剧库写操作 + 公告配置 |
| `dpcca_auth` | 邮箱验证码 / 用户档案 |
| `reviews_api` | 评论墙数据接口 |
| `feedback_api` | 用户反馈接口 |
| `anime-api-src` | 番剧资料 API |

其中 `admin_login` 需在云函数配置中设置环境变量：

```
ADMIN_USERNAME=你的管理员账号
ADMIN_PASSWORD=你的管理员密码
```

### 5. 上线静态托管

开通 CloudBase 静态托管，将 `Dpcca/` 下全部 `*.html` 与 `*.js` 文件上传至托管根目录即可，默认域名形如 `https://<envId>-<appId>.tcloudbaseapp.com/`。

### 实现要点（自助排查用）

- Web 端访问数据库必须处于登录态，页面代码启动时自动完成匿名登录
- `user_anime` 严格规则下定点 `doc(uid).set()` 会被拒，页面统一采用「查询存在 → `where({_openid:"{openid}"}).update()` 更新 / 不存在 → `add({data, userId:"{openid}"})` 创建」模式
- 管理后台写库必须调用云函数 `admin_login`（内部校验管理员后直连数据库），前端无法绕过
- SDK 的 `doc().get()` / `where().get()` 返回 `{ data: [...] }` 数组形式，代码已做 `Array.isArray` 兼容
- 评分室实时同步依赖 `db.collection("room_sessions").doc(id).watch({ onChange })`
- 若浏览器无法访问 CDN（离线 / 内网），把 `dataProvider.USE_CLOUD` 置 `false` 即可纯本地运行

## 目录结构

```
├── Dpcca/                  # 前端站点源码
│   ├── server.js           # 零依赖本地静态服务器（端口 5173）
│   ├── index.html          # 单人追番评分库
│   ├── rating.html         # 多人联合评分室
│   ├── profile.html        # 我的追番清单
│   ├── admin.html          # 番剧管理后台（账号密码登录）
│   ├── db-template.html    # 数据库模板页
│   ├── auth.js             # 账号系统（游客 + 邮箱绑定 + 数据迁移）
│   ├── reviewwall.js       # 评论墙组件（index / profile 共用）
│   ├── feedback.js         # 用户反馈入口组件（index 引用）
│   └── announcement.js     # 公告弹窗组件（三页共用，含管理后台预览）
└── cloudfunctions/         # 云函数源码
    ├── admin_login/        # 管理后台登录 + 公告配置 + 番剧库写操作
    ├── dpcca_auth/         # 邮箱验证码 / 用户档案
    ├── reviews_api/        # 评论墙数据接口
    ├── feedback_api/       # 用户反馈接口
    └── anime-api-src/      # 番剧资料 API
```

## 目前已部署链接

https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/index.html

## 数据来源声明

站内番剧资料基于「長門有C（[yuc.wiki](https://yuc.wiki)）」素材按 CC BY-NC-SA 4.0 协议衍生，二次使用请遵循[该协议](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh)。
