# yuc.wiki 季度新番 爬取与入库流程说明

> 适用项目：DPCCA 番剧追番 + 多人联合评分系统
> 目标集合：`anime_library`（CloudBase 环境 `dpcca-wiki-d7g0dl19y23cd30f3`）
> 静态托管：`https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com`
> 制定：2026-09-12 v1.0 ｜ 修订：2026-09-12 v1.1（2026 年 10 月番首次实跑复盘）
> 修订：2026-09-12 v1.2（线上 68 条 `desc` 批量修正，见第八节、第九节）
> **本文档是唯一的爬取入库操作依据；脚本实现以 `_crawl/crawl-yuc.ps1` 为准，文档不再复制脚本全文（原因见第五节）。**

---

## 零、一次季度入库的完整动作

```powershell
# ① 抓取 + 解析 + 生成入库件/分片/对账清单（一条命令，无需手工做 UTF-8 副本）
powershell -ExecutionPolicy Bypass -File .\_crawl\run.ps1 -Ym 202701

# ② 上传封面：本地 _crawl\202701\covers\*.jpg  →  托管 covers/202701/
# ③ 逐片入库：payload 直接取 _crawl\202701\chunks\chunk-00N.json（每片 = 一次 insert 请求体）
# ④ 回读对账：比对 _crawl\202701\_verify_202701.txt 的 id 全集（见第六节）
```

| 步骤 | 做什么 | 用到的工具 | 产物 |
| --- | --- | --- | --- |
| ① 抓取解析 | 拉季度页、结构化、切分片 | `run.ps1` + `crawl-yuc.ps1` | `_import_*.json/.ndjson`、`chunks/*.json`、`_verify_*.txt` |
| ② 封面 | 下载 → 上传托管 | `manageHosting` | `covers/<id>.jpg`、`_covers_*.txt` |
| ③ 入库 | 逐片 insert | `writeNoSqlDatabaseContent` | 线上文档 |
| ④ 对账 | 回读 id 集合比对 | `readNoSqlDatabaseContent` / `queryHosting` | 缺口清单 |

> ⚠️ 数据库批量写入前**必须先向用户说明方案并获确认**（项目既定规则）。

---

## 一、季度页面 URL

| 季度 | 月份 | URL |
| --- | --- | --- |
| 冬 | 1 月 | `https://yuc.wiki/YYYY01/` |
| 春 | 4 月 | `https://yuc.wiki/YYYY04/` |
| 夏 | 7 月 | `https://yuc.wiki/YYYY07/` |
| 秋 | 10 月 | `https://yuc.wiki/YYYY10/` |

- 规律：`https://yuc.wiki/` + `YYYY` + `MM`。**直接用季度子路径**，根路径可能超时。
- 页面标题形如 `2026年10月新番表 | 長門番堂`。
- 页面约 100~125 KB、条目块 68 个（2026-10）；若抓到 9 KB 级页面 = 命中 GitHub Pages 404 页，检查 URL。

---

## 二、ID 命名规则（自 2026 年 10 月番启用）

```
a + YY + MM + NN
```

| 片段 | 含义 |
| --- | --- |
| `a` | 固定前缀 |
| `YY` | 年份后两位（2026 → `26`） |
| `MM` | 季度页月份两位（1/4/7/10） |
| `NN` | 两位序号，从 `01` 起，**按页面条目出现顺序**递增（超 99 部顺延三位） |

| 季度 | ID 区间 |
| --- | --- |
| 2026 年 10 月 | `a261001` ~ `a261068` |
| 2027 年 1 月 | `a270101` ~ `a2701NN` |
| 2027 年 4 月 | `a270401` ~ `a2704NN` |

> 序号**只在标题解析成功后自增**（v1.1 修正）。旧写法在标题为空时也自增，会静默造成 id 跳号。
> 历史 ID（`a001`、`a1001`、`a401` 等）保持不变不回改；前端排期请按 `year/month/day` 排序，`id` 仅作唯一键。

---

## 三、流程总览

```
步骤 0  编码前置   crawl-yuc.ps1 补 UTF-8 BOM（run.ps1 自动完成）
步骤 1  抓取       yuc.wiki 季度页            →  _yuc_YYYYMM.html
步骤 2  解析       HTML                       →  _yuc_YYYYMM.json
步骤 3  构件       _yuc_*.json                →  _import_*.json / .ndjson
                                              →  chunks/chunk-00N.json（入库请求体）
                                              →  _verify_*.txt（对账清单）
步骤 4  封面       原图链接                   →  covers/YYYYMM/<id>.jpg（托管）
                                              →  _covers_*.txt（与托管对账）
步骤 5  入库       chunks/chunk-00N.json      →  anime_library（逐片 insert）
步骤 6  对账       回读线上                   →  id 集合比对，缺口补齐
步骤 7  收尾       复核 / 记录 / 清理中间件
```

---

## 四、操作步骤

### 步骤 0 编码前置（必须）

Windows PowerShell 5.1 会把**无 BOM 的 UTF-8 脚本按 ANSI 解析**。`crawl-yuc.ps1` 含中文正则与中文映射表（`原创/漫画改/导演/编剧`…），编码错就会静默产出空字段。

因此**统一经 `run.ps1` 启动**：它会把 `crawl-yuc.ps1` 重新保存为 UTF-8 **with BOM**（幂等，可反复执行），再调用它。

```powershell
powershell -ExecutionPolicy Bypass -File .\_crawl\run.ps1 -Ym 202610
```

> v1.0 的做法是手工维护一份 UTF-8 转存副本 `crawl-run.ps1`，**已废弃删除**：副本会与源脚本漂移（实测副本里仍留着旧的带 Referer 下载代码）。`run.ps1` 自身是 ASCII-only，不含中文，不存在同类风险。

### 步骤 1~3 抓取 / 解析 / 构件

```powershell
# 常规：抓取 + 解析 + 构件 + 下封面
powershell -ExecutionPolicy Bypass -File .\_crawl\run.ps1 -Ym 202610

# 只重下封面（复用已有 _yuc_*.json）
powershell -ExecutionPolicy Bypass -File .\_crawl\run.ps1 -Ym 202610 -OnlyCover

# 跳过封面，只重跑解析与构件
powershell -ExecutionPolicy Bypass -File .\_crawl\run.ps1 -Ym 202610 -SkipCover
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Ym` | 必填 | 季度，如 `202610` |
| `-OutDir` | `_crawl\<Ym>` | 产物目录（`run.ps1` 默认值） |
| `-ChunkSize` | `10` | 入库分片大小 |
| `-SkipCover` | — | 不下载封面 |
| `-OnlyCover` | — | 只下载封面（需已有 `_yuc_*.json`） |

解析要点：

- 按 `<!--#[A-E]\d+-->` 注释切块；A/B/C/D/E 只是类型分组，**不重置序号**。
- `source` 以 `<td class="type_X_r">` 的 **class 后缀**判定（比中文文本稳）：a 原创 / b 漫画改·韩漫改 / c 小说改 / d 游戏改 / e 其他。
- `class` 名可能带数字后缀：`title_cn_r1`、`title_jp_r2`、`staff_r2`、`type_tag_r1`，正则需兼容。
- 标题含 `<br>` 时先替换为空格再去标签。

自检输出（必须人工扫一眼）：

```
blocks = 68  withTitle = 68  items = 68     ← 三者不一致就要查解析
cross-month : N                              ← 跨月开播清单
exceptions  : …                              ← 缺原作/缺导演/无标签/待定日期
```

### 步骤 4 封面

- 原图取条目块内首个 `data-src`（`i0.hdslb.com`），统一命名 `<id>.jpg`。
- 下载：**必须不发送 Referer**。hdslb 校验 Referer，带上反而 403；脚本内置 3 次重试 + 坏文件（<1 KB）剔除重下。
- 上传：只上传 `covers/YYYYMM/` 内的图片到托管同名目录，**严禁整目录覆盖站点根或新建二级副本目录**。
- 入库 `cover` 字段写完整托管 URL：
  `https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/covers/YYYYMM/<id>.jpg`
- **托管对账要点**：`queryHosting(action="findFiles", prefix="covers/YYYYMM/")` 的返回**顶层 `files` 恒为空数组，真实列表在 `result.Contents`**。别拿 `files` 判断数量，否则会误报"0 个文件"。

### 步骤 5 入库

- 通道：`writeNoSqlDatabaseContent`（`action=insert`、`collectionName=anime_library`），或控制台导入 `_import_*.ndjson`。
- `action=insert` 的 `documents` 直接取 `chunks/chunk-00N.json` 里的 `documents` 数组（该文件本身就是完整请求体，`action/collectionName/documents` 已填好）。
- **每片 10 条**，逐片提交，便于定位失败片。
- **大批量（≥100 条）备用通道：临时导入云函数**（2026-09-13 新增，见第十一节 v1.3）。
  把各季 `chunks/*.json` 的 `documents` 按季/片顺序**文本级**拼接成 `data.json`
  （只做字符串切片拼接，不走 `ConvertFrom-Json` → `ConvertTo-Json`，避免编码/类型漂移），
  与一次性云函数（`@cloudbase/node-sdk`，`db.collection("anime_library").add(batch)`）
  一起放 `cloudfunctions/<函数名>/`，用 `manageFunctions(action=createFunction,
  functionRootPath=<...>/cloudfunctions)` 部署，`action=invokeFunction` 调用：
  `{dryRun:true}` 只统计（按 `id` 幂等去重）、`{dryRun:false}` 执行写入、
  `{action:"diff"}` 把库内文档与 `data.json` 逐条**全字段**比对。
  写完必须 `deleteFunction`（`confirm=true`）并删除本地函数目录。
  该通道数据不经过对话、凭据不落库，保真度更高；条数少时仍走上一条分片通道。

### 步骤 6 对账（不可跳过）

```js
// 回读：按 year + quarter 过滤（不要按 month，见第八节跨月）
readNoSqlDatabaseContent {
  collectionName: "anime_library",
  query: { year: 2026, quarter: 4 },
  projection: { _id: 0, id: 1 },
  limit: 200
}
```

判定规则：

1. **比对 id 集合是否与 `_verify_YYYYMM.txt` 完全相等**，而不是只比条数。
2. 缺 id → 用对应 `chunk-00N.json` 补写该片。
3. 多 id / 重复 id → 删除多余文档（**删除属危险操作，先经用户确认**）。
4. 抽查 3~5 条：`id / title / quarter / cover` 一致性。
5. 兜底抽查 2~3 个封面 URL 是否 HTTP 200 `image/jpeg`。

### 步骤 7 收尾

- `_summary_YYYYMM.txt` 已落盘本次全部日志（统计 + 异常清单），归档保留。
- 中间件（手工拼的 `arg*.txt`、临时分片）一律删除；**保留** `_import_*`、`chunks/`、`_verify_*`、`_covers_*`、`_summary_*`、`_yuc_*`、`covers/`。
- 在本文档第十一节追加变更记录。

---

## 五、字段映射表（HTML → JSON）

### 条目级

| 目标字段 | HTML 来源 | 说明 |
| --- | --- | --- |
| `title` / `cn` | `<p class="title_cn_r">`（可能 `_r1`/`_r2`） | `<br>` → 空格 |
| `jp` | `<p class="title_jp_r">`（可能 `_r2`） | 同上 |
| `source` | `<td class="type_[a-e]_r">` 的 class 后缀 | 见下映射表 |
| `tags` | `<td class="type_tag_r">`（可能 `_r1`） | 按 `/` 拆分 |
| `staff` | `<td class="staff_r">`（可能 `_r2`） | `<br>` 分行，`键：值` |
| `cast` | `<td class="cast_r">` | `<br>` 分行，行内空白分隔 |
| `broadRaw` | `<p class="broadcast_r">` | 如 `10/3周六深夜` |
| `exRaw` | `<p class="broadcast_ex_r">` | 如 `(全20话)`，常为空 |
| `cover` | 块内首个 `data-src` | hdslb 原图链接 |

### 类型 → `source`

| class 后缀 | 页面类型文本 | `source` |
| --- | --- | --- |
| `type_a_r` | 原创动画 | `原创` |
| `type_b_r` | 漫画改编动画 / 韩漫改编动画 | `漫画改` |
| `type_c_r` | 小说改编动画 | `小说改` |
| `type_d_r` | 游戏改编动画 / 游戏衍生动画 | `游戏改` |
| `type_e_r` | 吉祥物形象 / 绘本改编等 | `其他` |

> `index.html` 的 `SOURCES` 为 `["原创","漫画改","游戏改","小说改","动画改","影视改"]`，
> `rating.html` 房间筛选器只有 `漫画改 / 小说改 / 原创 / 待定`。
> **`其他` 不在任何筛选器选项中**：选「全部来源」仍可见；若需单独筛选需同步补前端选项。

### `staff` 键映射

| JSON 字段 | 优先取 | 备选 |
| --- | --- | --- |
| `original` | 原作 | 原案 |
| `director` | 导演 | 总导演 / 系列导演 |
| `writer` | 编剧 | 脚本 |
| `music` | 音乐 | — |
| `studio` | 动画制作 | — |

> 其余键（动画人设、副导演、总作监、插画等）不入库。**字段缺失时留空字符串，不要填占位符。**

### 播出时间解析（`broadRaw` 形如 `10/3周六深夜`）

| JSON | 规则 |
| --- | --- |
| `month` | `^(\d+)/`，取**源页真实开播月**（可跨出季度月） |
| `day` | `/(\d+)`，无日期记 `0` |
| `week` | `周一`→1 … `周日`→7；未知一律 `7`（与历史数据一致） |

### 集数

`exRaw` 形如 `(全20话)` → `episodes=20`；**解析不到填 `0`**（源站未提供，不要臆造）。

---

## 六、入库与校验规范（v1.1 新增，务必遵守）

### 1. 分片写入
- 每片 10 条，payload 直接来自 `chunks/chunk-00N.json`。
- 逐片提交并**逐一确认返回**（`insertedCount` 应等于该片条数）。

### 2. 写后必回读
> **2026-10 实跑事故**：第 5 片（`a261041`~`a261050`）返回 `insertedCount:10 / 文档插入成功`，
> 但线上集合里**这 10 条根本不存在**。只靠回读才发现，最终总数 58 ≠ 68。

因此：**"接口返回成功" ≠ "数据已落库"**。每片写完后回读该片 id 是否存在，全部写完后做一次全量对账。

### 3. 判定依据是 id 集合，不是条数
- 只看 `total` 会漏判——缺 A 片 10 条 + 混入历史 10 条，总数照样"正确"。
- 正确做法：拉回本季度全部 `id`，与 `_verify_YYYYMM.txt` 逐一对齐（集合相等）。

### 4. 重跑前必须清理旧段
同一季度重跑时，若线上已有该季度数据，**必须先删除旧 `id` 段再插入**，否则会整体重复：

```
id 范围：<Prefix>01 .. <Prefix>99    （如 a261001 .. a261099）
```

脚本在检测到本地产物已存在时会打印此告警。删除操作属危险变更，执行前须经用户确认并留存备份（可先导出 `_import_*.ndjson` 所需字段）。

### 5. 不要用 `month` 过滤季度
10 月番里存在 9 月下旬、11 月开播的作品（2026-10 共 5 条：`a261011` 9/25、`a261012` 9/30、`a261030` 11/26、`a261047` 9/27、`a261062` 11/6）。
**对账一律按 `year + quarter`**，`month` 记源页真实开播月。

---

## 七、两条 JSON 的结构

### 中间态 `_yuc_YYYYMM.json`

```json
{
  "idx": 1, "cn": "顶点武装", "jp": "VERTEX FORCE", "title": "顶点武装",
  "source": "原创", "type": "原创动画", "tags": ["科幻", "机战", "股"],
  "staff": { "original": "", "director": "高村和宏", "writer": "高村和宏", "music": "信泽宣明", "studio": "SMDE" },
  "cast": ["小市真琴", "本渡枫", "小清水亚美", "潘惠美", "高桥李依"],
  "month": 10, "day": 3, "broadRaw": "10/3周六深夜", "exRaw": "", "episodes": 0, "time": "",
  "cover": "https://i0.hdslb.com/bfs/new_dyn/xxxx.jpg", "week": 6, "coverLocal": "a261001.jpg"
}
```

> `type` 存页面原始类型文本；入库态的 `type` 固定为 `tv`，两者不要混淆。

### 入库态 `_import_YYYYMM.json`（另出 `.ndjson`，每行一条）

```json
{
  "id": "a261001", "title": "顶点武装", "jp": "VERTEX FORCE",
  "desc": "「顶点武装」2026年10月新番，原创作品，10月3日开播。",
  "emoji": "🎬", "gradient": ["#2b1f4f", "#14245e"],
  "cover": "https://dpcca-wiki-d7g0dl19y23cd30f3-1466587016.tcloudbaseapp.com/covers/202610/a261001.jpg",
  "year": 2026, "month": 10, "quarter": 4, "day": 3, "week": 6, "episodes": 0,
  "type": "tv", "source": "原创",
  "staff": { "original": "", "director": "高村和宏", "writer": "高村和宏", "music": "信泽宣明", "studio": "SMDE", "cast": ["…"] },
  "tags": ["科幻", "机战", "股"]
}
```

固定值：`emoji=🎬`、`gradient=["#2b1f4f","#14245e"]`、`type=tv`、`quarter`（1=1月/2=4月/3=7月/4=10月）。

`desc` 模板（**`$()` 包裹变量，见第九节坑 1**）：

```
「{title}」{year}年{month}月新番，{source}作品，{month}月{day}日开播。
day = 0 时末段换成：开播日期待定。
```

---

## 八、已知限制与约定

| 项 | 现状 | 处理 |
| --- | --- | --- |
| `episodes` | 源页 `broadcast_ex_r` 常为空占位，2026-10 全部为 `0` | 保留 `0`，不臆造；脚本会统计 zero-episodes 数 |
| `desc` | 模板文案，非剧情简介（源页不含简介） | 保持模板；2026-10 线上 68 条缺「2026年10月新番」的问题已于 2026-09-12 批量修正（v1.2） |
| `week` | 源页常有 `深夜/网络放送` 等无星期写法 | 未知一律 `7` |
| `day` | 部分作品开播日期未定 | `day=0`，desc 用「开播日期待定。」 |
| `month` | 可跨季度月 | 记真实开播月；对账用 `year+quarter` |
| `source=其他` | 前端筛选器无此选项 | 需筛选时补前端选项 |
| `quarter` | 必须填序号 `1/2/3/4`，不是月份 | 线上存量部分 7 月番被写成 `1`，属历史脏数据，不批量回改 |

---

## 九、踩坑清单（2026-10 复盘）

1. **中文紧邻变量名会吞字段**：`"$Year年$Month月新番"` 中汉字属 Unicode 字母，被并入变量名解析为未定义变量，整段变空。
   必须写 `"$($Year)年$($Month)月…"`。
   2026-10 线上 68 条 `desc` 曾因此丢失「2026年10月新番」（本地与线上入库件均少 18 字节/条），
   **已于 2026-09-12 按修复后脚本逐条 `$set` 修正，回读校验 `total=68` 全部通过**（v1.2）。
   脚本已加护栏：`desc` 不含 `{Year}年` 直接 throw。
2. **脚本文本编码**：PS 5.1 按 ANSI 解析无 BOM 的 UTF-8 脚本 → 中文正则/映射全废，且**不报错、静默产出空字段**。
   统一走 `run.ps1`（自动补 BOM）；读无 BOM 的 UTF-8 文本一律显式 `-Encoding UTF8`。
3. **`insert` 返回成功 ≠ 已落库**：整片 10 条丢失但接口返回 `成功`，只能靠回读发现。见第六节。
4. **对账不能只看条数**：必须比对 id 集合。
5. **对账不能按 `month` 过滤**：跨月开播作品会被漏掉。
6. **hdslb 图床**：下载必须**不带 Referer**，带了就 403。
7. **托管 `findFiles` 返回结构**：真实列表在 `result.Contents`，顶层 `files` 恒为空。
8. **不要维护脚本副本**：`crawl-run.ps1` 这类转存副本会漂移（实测残留旧逻辑），已删除。
9. **id 编号时序**：序号自增须在标题校验通过之后，否则空标题会跳号。
10. **`JavaScriptSerializer` 不可用**：中文/复杂对象下报错，改用 `ConvertTo-Json -Depth 10` + `-InputObject` 传数组（避免单元素被展平为对象）。
11. **集数为 0 不是 bug**：源站未提供，核实后保留。
12. **日志要落盘**：只打控制台的话，会话一结束异常清单就没了（`_summary_*.txt`）。
13. **上传只传封面文件**：严禁整目录上传本地 `Dpcca/` 或在云端新建二级副本目录。
14. **抓取后先核对条数**：2026-10 应为 68 条（A6 / B34 / C23 / D2 / E3），数量异常先查解析再看数据。

---

## 十、脚本与产物

### `_crawl/run.ps1`（ASCII-only 启动器）
补 UTF-8 BOM + 转发调用。**保持 ASCII-only，不要写入中文。**

### `_crawl/crawl-yuc.ps1`（唯一实现）
参数见步骤 1~3 表。产出：

| 文件 | 用途 |
| --- | --- |
| `_yuc_<Ym>.html` / `.json` | 原始页面 / 中间态 |
| `_import_<Ym>.json` / `.ndjson` | 入库结构 / 控制台导入用 |
| `chunks/chunk-NNN.json` | **入库请求体**，每片一次 insert |
| `_verify_<Ym>.txt` | 对账清单（期望 id 全集 + 查询建议） |
| `_covers_<Ym>.txt` | 封面清单（文件名 + 字节数），与托管对账 |
| `_summary_<Ym>.txt` | 运行日志（统计 + 异常） |
| `covers/<id>.jpg` | 封面实体文件 |

### 归档
历史产物（旧 JSON、旧封面、数据库导出）在 `releases/dpcca-v1.0.0-test-20260907/legacy_files/`，**不要删除**。

---

## 十一、变更记录

| 日期 | 版本 | 内容 |
| --- | --- | --- |
| 2026-09-12 | v1.0 | 首次制定；ID 规则改为 `a + YY + MM + NN`，自 2026 年 10 月番生效 |
| 2026-09-12 | v1.1 | 2026-10 实跑复盘：① 新增 `run.ps1` 自动补 UTF-8 BOM，删除会漂移的 `crawl-run.ps1` 副本；② 新增分片入库件 `chunks/`、对账清单 `_verify_*.txt`、封面清单 `_covers_*.txt`、日志落盘 `_summary_*.txt`；③ 修正 id 编号时序（标题为空时不再自增）；④ 修正 `desc` 插值（`$Year年` → `$($Year)年`）并加护栏；⑤ 封面下载加 3 次重试与坏文件剔除；⑥ 新增跨月开播检测与 `其他` 来源告警；⑦ 文档移除内嵌脚本全文，改为以磁盘脚本为唯一实现；⑧ 新增「入库与校验规范」（回读、id 集合比对、重跑清理）与「踩坑清单」 |
| 2026-09-12 | v1.2 | 线上数据修正（经用户确认后执行）：按修复后脚本重新生成入库件，对 `anime_library` 中 2026 年 10 月番 68 条文档逐条 `$set` 修正 `desc`，补回「2026年10月新番」；执行前确认新旧入库件除 `desc` 外零差异，执行后回读校验 `total=68` 且 68 条全部命中，`_id` 与其他字段均未改动；本地入库件 120401 → 121625 字节（68 × 18 字节，与预期一致） |
| 2026-09-13 | v1.3 | 2025 全年四季入库（经用户确认后执行）：抓取 `202501/202504/202507/202510` 共 246 条（54/65/67/60），封面 246/246 下载并上传 `covers/2025xx/`（`findFiles` 复核 54/65/67/60）；id 沿用 `a+YY+MM+NN`（`a250101`–`a251060`），与既有 251 条零重叠、未删除任何旧数据；入库新增「临时导入云函数」通道（`tmpCrawlImport2025`，服务端 `@cloudbase/node-sdk` 按 id 幂等批量写入，写完即 `deleteFunction` 并清理本地函数目录），首次写入 246 条 0 失败；校验：id 集合命中 246/246、`{action:"diff"}` 全字段比对 246 条零差异、`year=2025` 回读 248 条（= 246 新增 + 遗留 `a1008`/`a1014`，其 `month=12` 属跨月开播）；第四节步骤 5 补充该通道说明 |
