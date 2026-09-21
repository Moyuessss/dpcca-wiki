# DPCCA · 番剧追番 + 多人联合评分双站系统

## 当前版本：v4.0 测试版（Beta）

- 状态：**测试版 4.0**（2026-09-22 评分预设重构：筛选 chips 化 + 番剧勾选排序 + 一键应用）
- 版本里程碑：v1.0.0（2026-09-07）→ v2.1（2026-09-12，公告弹窗）→ v3.0（2026-09-14）→ v3.1（2026-09-15）→ v4.0（2026-09-22）
- 模块：单人追番评分库 `index.html` · 我的追番清单 `profile.html` · 多人联合评分室 `rating.html` · 番剧管理后台 `admin.html`
- 数据层：CloudBase 环境 `dpcca-wiki-d7g0dl19y23cd30f3`（集合：`anime_library` / `user_anime` / `user_profiles` / `room_sessions` / `site_config`）

> 当前各公开页右上角均已显示「测试版 v4.0」徽标。测试期间数据/功能可能调整，反馈请走 README 渠道。

### v4.0 新增功能（2026-09-22）：评分预设

- **管理后台**（`admin.html` → 「评分预设」）：
  - 预设 = **筛选条件 + 番剧勾选 + 评分顺序** 的组合模板，存于 `site_config` 单文档 `doc("rating_presets")` = `{ list: [{ name, config, updatedAt, updatedBy }] }`（规则 read=true / write=false，写入仅经云函数 `admin_login`）
  - 筛选界面重构：年份 / 季度 / 月份 / 来源 / 类型全部改为**点选标签（chips）**多选（不选 = 全部），口径与前台 `rating.html` 完全一致；评分模式以圈码 ①②③ 显示依次进行的顺序，点击即勾选/取消
  - **番剧勾选与评分顺序**：左侧按当前筛选实时列出命中番剧（支持标题/ID 搜索、全选命中、按开播日期/标题排序），点击勾选加入右侧「已选列表」；已选列表支持**拖拽**与 ↑↓ 按钮调序，保存为有序 `animeIds` 数组（≤ 500 部）
  - 预设列表摘要显示筛选条件、分数制、模式与已选部数；支持编辑回填与删除
- **多人评分室**（`rating.html`）：房主配置区新增**预设按钮**（悬停提示「一键应用：筛选 + 番剧勾选 + 评分顺序」），点击即一键填入筛选并按预设勾选与顺序选中番剧（`room.selectedIds`），未勾选番剧的预设保持旧行为（自动全选命中番剧）；未配置 / 离线时自动隐藏按钮
- **云函数** `admin_login`：`sanitizePresetConfig` 新增 `animeIds`（字符串数组，≤ 500）清洗透传；`presetList / presetSave / presetDelete` 三个 action 不变
- 存量数据无需迁移：旧预设无 `animeIds` 字段时前台自动按「全选命中」处理

### v3.1 新增功能（2026-09-15）：番剧 PV 链接按钮

- **前台**（`index.html` / `profile.html`）：详情弹窗「开播前预期分」标题旁新增 **PV 按钮**——管理后台填了 PV 链接显示**绿色**可点击，新标签页跳转；未填写显示**灰色**不可点（悬停提示「管理员暂未填写 PV 链接」）。链接做了清洗（剔除引号/尖括号，缺协议自动补 `https://`），`rel="noopener noreferrer"`。
- **多人评分室**（`rating.html`）：「查看详情」弹窗番剧标题旁新增同款 PV 按钮，样式与跳转逻辑与其它两页一致。
- **管理后台**（`admin.html`）：番剧编辑弹窗「隐藏关键词」下方新增 **「PV 链接」输入框**，保存时写入数据库 `pvUrl` 字段、编辑时回填。
- **数据**：`anime_library` 集合新增可选字段 `pvUrl`（字符串，URL），存量数据无需迁移；云函数 `admin_login` 的 `sanitize` 无字段白名单，新字段直接透传，云函数无改动。
- **数据来源署名**（合规修正）：三页（`index` / `profile` / `rating`）页脚新增 CC BY-NC-SA 4.0 署名声明——注明番剧资料基于「長門有C（yuc.wiki）」素材衍生，附协议链接。

### v3.0 新增功能（2026-09-14）

- **追番评分库 / 我的追番清单**（`index.html` / `profile.html`）：
  - 新增「季度」筛选（1 月冬 / 4 月春 / 7 月夏 / 10 月秋，口径与后台完全一致，直接对应数据库 `quarter` 字段）；月份与季度同属开播时间维度，同时选中时取并集
  - 所有筛选项改为**多选**（空集合 = 不限该项）；`normQuarter()` 自动把存量遗留的月份值折回季度序号，保证旧数据可被筛选
- **多人评分室**（`rating.html`）：
  - 季度筛选与全维度多选（年份 / 月份 / 季度 / 来源 / 类型，空数组 = 不限）
  - 点击「应用配置」前不展示候选番剧列表
  - **房主密码锁**：开启后成员加入需输入密码（房间数据只存密码摘要，不存明文）
  - **房间号隐藏**：开启后全员（含房主）只见 `******`，且进入房间后自动清除地址栏 `?room=` 参数
- **统一短评评论框组件**（`cmtBoxHTML`）：`index` / `profile` / `rating` 三页共用，textarea 加宽、自动换行、右下角可放大/还原（最高 170px ↔ 420px）；「单集短评」保持原样不变

### v2.1 新增功能：公告弹窗（2026-09-12）

- **管理后台配置**：`admin.html` → 「公告弹窗」，提供启用开关、内容编辑（纯文本 ≤ 2000 字）以及与线上完全一致的预览。
- **展示规则**：`enabled=true` 且有内容时，用户**每次进入** `index.html` / `rating.html` / `profile.html` 都会自动弹出，覆盖在页面内容之上，不依赖登录态（游客同样可见）。
- **关闭方式**：右上角 `×`（或点击遮罩）仅关闭本次，下次进入仍会弹出；底部勾选「不再弹出」后本机持久化静默，之后不再显示。
- **内容更新**：静默记录绑定「公告内容指纹」，管理员**改动内容后**，此前勾选过「不再弹出」的用户会重新看到新公告（内容未变则保持静默，避免公告更新后无人可见）。
- **数据存储**：集合 `site_config` 单文档 `doc("announcement")` = `{ enabled, content, updatedAt, updatedBy }`；规则 `read=true / write=false`，前台只读，写入仅经云函数 `admin_login`（`action=configGet` / `configSave`）。
- **组件**：`announcement.js`（三页共用，样式与逻辑自包含，不依赖 Tailwind）。管理后台本页设 `window.DPCCA_ANNOUNCE_AUTO=false` 禁止自动弹出，只复用其预览能力。
- **管理后台自身不弹公告**：`admin.html` 不触发自动弹出，避免干扰管理员操作。

纯前端 Web 双站应用：**单人追番评分库** + **多人联合评分室**，数据层已接入腾讯云开发（CloudBase）文档型数据库，支持多设备实时同步。

## 快速开始

```bash
node server.js
```

- 单人追番评分库：http://localhost:5173/index.html
- 多人联合评分室：http://localhost:5173/rating.html

`server.js` 为零依赖本地静态服务器，仅使用 Node 内置模块（http / fs / path）。

## 双站功能

### 站点 1：单人追番评分库（index.html）

- 季度浏览：按 1 月 / 4 月 / 7 月 / 10 月季度 Tab 切换番剧
- 搜索：按标题 / 类型 / 标签实时过滤
- 详情弹窗：封面、简介、播出季度、类型、标签
- 三级评分体系：
  - 开播评分（首集观感）
  - 单集评分（每集可独立打分）
  - 完结评分（追完总结）
- 追番状态：在看 / 看完 / 弃番，单集观看进度勾选
- 完结撒花：完结动画特效
- 分享卡片：一键导出「我的季度评分」一图流 PNG（html2canvas）
- 数据持久化：本地 localStorage，登录后自动同步云端

### 站点 2：多人联合评分室（rating.html）

- 房间系统：创建房间（云端查重）、输入房间号加入、URL `?room=` 邀请链接直达
- 昵称记忆：昵称存入云端，跨设备保持
- 房主权限：配置评分轮次、移除成员、开启评分
- 轮流评分：每人每轮对指定番剧打分，提交后锁定，房主可放行修改
- 实时同步：云端 `watch()` 实时监听房间数据，成员在线状态实时刷新（本地 BroadcastChannel 降级）
- 统计弹窗：实时查看各成员评分进度
- 结果页：排行榜、长图导出（html2canvas）、CSV 导出（含 BOM，Excel 可直接打开）

## 技术栈

| 依赖 | 说明 |
| --- | --- |
| Tailwind CSS CDN | 原子化样式 |
| Font Awesome 6 CDN | 图标 |
| html2canvas 1.4.1 CDN | 分享卡片 / 排行榜长图导出 |
| @cloudbase/js-sdk 2.32.0 CDN | 腾讯云开发 Web SDK（游客/邮箱账号登录 + 云数据库） |
| auth.js | 账号系统：游客模式 + 邮箱验证码绑定 + 邮箱密码登录 + 数据迁移 |
| 原生 JavaScript | 零构建，双击即用 |

## CloudBase 接入

### 环境

- 环境 ID：`dpcca-wiki-d7g0dl19y23cd30f3`
- SDK：`https://static.cloudbase.net/cloudbase-js-sdk/2.32.0/cloudbase.full.js`
- 登录方式：
  - **游客模式**：匿名登录兜底，无需注册；数据存本机 + 云端匿名 uid 文档
  - **邮箱账号**：`signUp` 发送验证码邮件 → `verifyOtp` 完成注册并自动迁移游客数据；之后用邮箱+密码 `signInWithPassword` 登录，跨设备同步
  - **管理后台**：账号密码由云函数 `admin_login` 读取环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 校验（代码中不含任何硬编码口令），写库必须经云函数
  - 注意：邮箱登录需在控制台「身份认证 → 登录授权」开启并配置 SMTP 发件邮箱

### 数据层封装（dataProvider）

两站共用统一数据层，通过 `USE_CLOUD` 开关路由：

```js
const dataProvider = {
  USE_CLOUD: true,          // true 走云端，false 走本地 localStorage
  ENV_ID: "dpcca-wiki-d7g0dl19y23cd30f3",
  loadUserData / saveUserData,  // 用户数据（追番 / 昵称）
  initAnimeData / loadAnimeLibrary,  // 番剧库（云端优先，失败回退内置 21 部）
  saveRoom / loadRoom,          // 多人房间数据（rating.html）
};
```

### 云数据库集合

| 集合 | 用途 | 安全规则 |
| --- | --- | --- |
| `anime_library` | 公共番剧库（196 部，含图片封面 `cover` 字段） | 读：所有人；写：**false（仅云函数可写）** |
| `user_anime` | 用户追番评分数据，按 uid 隔离 | 读/写：`doc._openid == auth.uid \|\| doc.userId == auth.uid` |
| `user_profiles` | 用户昵称档案 | 读/写：`auth != null`（登录即可） |
| `room_sessions` | 房间实时数据（成员、评分轮次、结果） | 读/写：`auth != null`（登录即可） |
| `site_config` | 站点级配置（v2.1 公告弹窗，单文档 `announcement`） | 读：所有人；写：**false（仅云函数 `admin_login` 可写）** |

> 规则说明：Web 端安全规则无 `auth.openid` 变量，必须使用 `auth.uid`（匿名/邮箱账号的 uid）。`user_anime` 集合严格按 uid 隔离，仅本人可读写自己的文档。

### 注意事项

- Web 端访问数据库必须处于登录态，代码启动时自动完成匿名登录
- **用户数据保存模式**：`user_anime` 严格规则下定点 `doc(uid).set()` 会被拒，页面统一采用「查询存在 → `where({_openid:"{openid}"}).update()` 更新 / 不存在 → `add({data, userId:"{openid}"})` 创建」模式，`{openid}` 占位符由服务端自动替换为当前 uid
- **管理后台写库**：`anime_library` 客户端已禁写，新增/修改/删除必须调用云函数 `admin_login`（内部校验管理员账号后直连数据库），前端无法绕过
- **数据迁移**：游客绑定邮箱成功后，页面 `auth.js` 自动把本地 + 云端匿名数据写入新邮箱账号的文档
- SDK 的 `doc().get()` / `where().get()` 返回 `{ data: [...] }` 数组形式，已做 `Array.isArray` 兼容
- 实时同步依赖 `db.collection("room_sessions").doc(id).watch({ onChange })`，同一房间所有成员共享一份文档
- 若浏览器无法访问 CDN（离线 / 内网），`dataProvider.USE_CLOUD` 置 `false` 即可纯本地运行

## 线上部署（CloudBase 静态托管）

- 静态托管域名：`https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/`
- 单人追番评分库：`https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/index.html`
- 多人联合评分室：`https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/rating.html`
- 数据库模板页：`https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/db-template.html`

更新方式：将 `index.html` / `rating.html` / `profile.html` / `admin.html` / `auth.js` / `reviewwall.js` / `feedback.js` / `announcement.js` / `db-template.html` 上传至环境 `dpcca-wiki-d7g0dl19y23cd30f3` 的静态托管根目录即可，CDN 约 1-3 分钟生效（可用 URL 后追加 `?v=时间戳` 强制刷新）。

## 目录结构

```
Dpcca/
├── server.js         # 零依赖本地静态服务器（端口 5173）
├── index.html        # 单人追番评分库
├── rating.html       # 多人联合评分室
├── profile.html      # 我的追番清单
├── admin.html        # 番剧管理后台（账号密码登录）
├── auth.js           # 账号系统（游客 + 邮箱绑定 + 数据迁移）
├── reviewwall.js     # 评论墙组件（index / profile 共用）
├── feedback.js       # 用户反馈入口组件（index 引用）
├── announcement.js   # 公告弹窗组件（v2.1 引入，三页共用，含管理后台预览）
└── README.md         # 本文档
```
