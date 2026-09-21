/**
 * admin_api - DPCCA 管理后台接口（云函数）
 * ------------------------------------------------------------
 * 鉴权：优先校验 dpcca_admins 集合（管理员账号表），未命中时
 * 兜底使用环境变量 ADMIN_USERNAME / ADMIN_PASSWORD（视为 super）。
 * ⚠️ 兜底凭据只来自云函数环境变量，源码不保留任何默认口令；
 *    未配置环境变量时该兜底通道自动关闭（不影响集合账号登录）。
 *
 * 支持的动作：
 *   action=login              校验管理员账号密码 -> { ok, accountName, role }
 *   action=save               新增或修改番剧（data 带 _id 为修改，否则新增）
 *   action=delete             删除番剧（data._id 为文档 ID）
 *   action=userList           用户列表：已注册用户 + 游客统计
 *   action=resetUserPassword  重置注册用户密码为随机乱码 -> 返回新密码
 *   action=adminList          管理员账号列表
 *   action=adminAdd           新增管理员（仅 super）
 *   action=adminDelete        删除管理员（仅 super，不能删自己 / 最后一个 super）
 *   action=adminChangePassword 修改管理员密码（super 可改任意，admin 仅能改自己）
 *
 * 评分/评论墙（anime_reviews，管理端统一管理用户评论与分数）：
 *   action=reviewList       评论列表：按 番剧/类型/集/状态/用户/关键词 过滤 + 分页（任意管理员）
 *   action=reviewStats      统计：总体概览/类型计数/分数直方/近30天/每番剧均分（任意管理员）
 *   action=reviewHide       隐藏某条评论（软删，可恢复，不参与展示与均分）[仅 super]
 *   action=reviewRestore    恢复被隐藏的评论 [仅 super]
 *   action=reviewDelete     彻底删除某条评论（不可恢复）[仅 super]
 *                           —— 同时联动删除该用户 user_anime 中同源的评分段，
 *                              保证管理后台删除与个人端档案一致
 *   action=reviewClearAnime 清空某番剧全部评论（管理页双确认后使用）[仅 super]
 *                           —— 同样联动清理各涉事用户的个人档案
 *   action=reviewBackfill   全量回填：把 user_anime 中 D 账号历史评分补齐成墙
 *                           （dryRun=true 仅预览统计不写入；幂等）[仅 super]
 *
 * 用户反馈（feedback，read=false / write=false）：
 *   action=feedbackStats   概览统计：总数 / 待处理 / 已处理 / 按类型（任意管理员）
 *   action=feedbackList    列表：按 状态 / 类型 / uid / 关键词 过滤 + 分页（任意管理员）
 *   action=feedbackMark    标记状态：done=已处理，new=重新打开（任意管理员）
 *   action=feedbackDelete  彻底删除某条反馈（垃圾反馈）[仅 super]
 *
 * 安全配合：anime_library 集合安全规则 read=true, write=false，
 * 客户端无法直接写库，所有写操作必须经过本云函数鉴权。
 * anime_reviews 集合规则 read=true, write=false，评论墙的行由
 * reviews_api 云函数（普通注册用户自助上墙）与本函数共同写入。
 * feedback 集合规则 read=false, write=false，用户提交由 feedback_api
 * 云函数写入，管理端列表 / 处理在本函数完成。
 *
 * 站点配置（site_config，read=true / write=false，前台各页只读）：
 *   action=configGet   读取公告弹窗配置（任意管理员）
 *   action=configSave  保存公告弹窗配置（任意管理员）
 *                      data.enabled 是否启用公告弹窗
 *                      data.content 公告正文（纯文本，<= 2000 字）
 *   单文档 doc("announcement")：{ enabled, content, updatedAt, updatedBy }
 *   前台 announcement.js 直读该文档，写入仅经本函数，客户端不可写。
 *
 * 评分预设（v4.0，site_config 同集合）：
 *   action=presetList    读取评分室预设列表（任意管理员）
 *   action=presetSave    新增（data.index 为空）或修改（data.index 为序号）预设
 *   action=presetDelete  删除指定序号的预设
 *   单文档 doc("rating_presets")：{ list: [{ name, config, updatedAt, updatedBy }] }
 *   前台 rating.html 直读该文档（read=true），写入仅经本函数。
 */
const tcb = require("@cloudbase/node-sdk");
const crypto = require("crypto");

const ENV_ID = process.env.TCB_ENV || "dpcca-wiki-d7g0dl19y23cd30f3";
const app = tcb.init({ env: ENV_ID });
const db = app.database();

/* 内置超级管理员：口令仅从云函数环境变量读取，源码与仓库不含明文。
 * 两个变量任一为空时，findAdmin 中的兜底校验自动失效。 */
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const COLL = "anime_library";        // 番剧库
const ACCOUNTS = "dpcca_accounts";   // 注册用户账号表
const ADMINS = "dpcca_admins";       // 管理员账号表
const USER_ANIME = "user_anime";     // 用户追番数据（用于游客统计）
const REVIEWS = "anime_reviews";     // 公开评分/评论墙（行式，write=false 仅云函数可写）
const FEEDBACK = "feedback";         // 用户反馈（read=false/write=false，用户经 feedback_api 提交）
const SITE_CONFIG = "site_config";   // 站点配置（read=true/write=false，公告弹窗配置单文档）

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function pick(doc) {
  if (!doc) return null;
  return Array.isArray(doc) ? doc[0] : doc;
}

function docId(prefix, name) {
  return prefix + "_" + Buffer.from(name, "utf8").toString("base64url");
}

/* 剔除前端传入的内部字段（_id / _openid / 时间戳），防止越权覆盖 */
function sanitize(data) {
  const o = {};
  for (const k of Object.keys(data || {})) {
    if (k === "_id" || k === "_openid" || k === "updatedAt" || k === "createdAt") continue;
    o[k] = data[k];
  }
  return o;
}

/* 分页拉取集合全量（Web SDK 单次 get 有限制，云函数侧同样做分页保险） */
async function fetchAll(col) {
  const PAGE = 1000;
  let skip = 0;
  let all = [];
  while (true) {
    let res;
    try {
      res = await db.collection(col).skip(skip).limit(PAGE).get();
    } catch (e) {
      break; // 集合不存在时视为空
    }
    const list = res.data || [];
    all = all.concat(list);
    if (list.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

/* 校验管理员：dpcca_admins 优先，环境变量兜底（super） */
async function findAdmin(name, password) {
  const uname = String(name || "").trim();
  const upwd = String(password || "");
  if (!uname || !upwd) return null;
  const res = await db.collection(ADMINS).doc(docId("a", uname)).get().catch(() => null);
  const doc = res ? pick(res.data) : null;
  if (doc && doc.status !== "disabled") {
    if (sha256(upwd + doc.salt) === doc.passwordHash) {
      return { accountName: doc.accountName, role: doc.role || "admin" };
    }
    return null;
  }
  // 兜底超级管理员：未配置环境变量时（任一项为空）该通道关闭
  if (ADMIN_USERNAME && ADMIN_PASSWORD && uname === ADMIN_USERNAME && upwd === ADMIN_PASSWORD) {
    return { accountName: ADMIN_USERNAME, role: "super" };
  }
  return null;
}

/* ============================================================
 * 用户管理
 * ============================================================ */
async function listUsers() {
  const accounts = await fetchAll(ACCOUNTS);
  const registered = accounts
    .filter(a => a && a.accountName)
    .map(a => ({
      accountName: a.accountName,
      uid: a.uid || "",
      nickname: a.nickname || "",
      createdAt: a.createdAt || 0,
      lastLoginAt: a.lastLoginAt || 0,
      status: a.status || "active",
      hasSecret: !!(a.secretQuestion && a.secretAnswerHash),
    }))
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));

  const uidSet = new Set(accounts.map(a => a.uid).filter(Boolean));
  // 游客统计：user_anime 中去重后的 _openid（非注册 uid 的部分）
  const userAnime = await fetchAll(USER_ANIME);
  const openids = new Set();
  userAnime.forEach(r => {
    const oid = (r && (r._openid || r.userId)) || "";
    if (oid) openids.add(oid);
  });
  let guestCount = 0;
  openids.forEach(oid => { if (!uidSet.has(oid)) guestCount++; });

  return {
    ok: true,
    registeredCount: registered.length,
    guestCount: guestCount,
    totalCount: registered.length + guestCount,
    users: registered,
  };
}

/* 生成随机乱码密码（10 位，避免易混淆字符） */
function genRandomPassword(len) {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const n = len || 10;
  const bytes = crypto.randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += charset[bytes[i] % charset.length];
  return s;
}

async function resetUserPassword(accountName) {
  const name = String(accountName || "").trim();
  if (!name) return { ok: false, message: "缺少账号名" };
  const id = docId("u", name);
  const res = await db.collection(ACCOUNTS).doc(id).get();
  const doc = pick(res.data);
  if (!doc) return { ok: false, message: "用户不存在" };
  const newPassword = genRandomPassword(10);
  const salt = crypto.randomBytes(8).toString("hex");
  await db.collection(ACCOUNTS).doc(id).update({
    passwordHash: sha256(newPassword + salt),
    salt: salt,
    updatedAt: Date.now(),
  });
  return { ok: true, accountName: name, newPassword: newPassword };
}

/* ============================================================
 * 管理员账号管理
 * ============================================================ */
async function listAdmins() {
  const admins = await fetchAll(ADMINS);
  const list = admins
    .filter(a => a && a.accountName)
    .map(a => ({
      accountName: a.accountName,
      role: a.role || "admin",
      createdAt: a.createdAt || 0,
      lastLoginAt: a.lastLoginAt || 0,
    }))
    .sort((x, y) => (x.role === "super" ? -1 : 1) || (y.createdAt || 0) - (x.createdAt || 0));
  return { ok: true, builtinAccount: ADMIN_USERNAME, admins: list };
}

async function addAdmin(accountName, initPassword, operatorRole) {
  if (operatorRole !== "super") return { ok: false, message: "仅超级管理员可新增管理员" };
  const name = String(accountName || "").trim();
  if (name.length < 2 || name.length > 20) return { ok: false, message: "账号名需 2-20 位" };
  if (name === ADMIN_USERNAME) return { ok: false, message: "该账号为系统内置管理员，无需重复添加" };
  if (!initPassword || String(initPassword).length < 8) return { ok: false, message: "初始密码至少 8 位" };
  const salt = crypto.randomBytes(8).toString("hex");
  const doc = {
    accountName: name,
    role: "admin",
    passwordHash: sha256(String(initPassword) + salt),
    salt: salt,
    createdAt: Date.now(),
    lastLoginAt: 0,
    status: "active",
  };
  try {
    await db.collection(ADMINS).doc(docId("a", name)).create(doc);
  } catch (e) {
    return { ok: false, message: "该管理员账号已存在" };
  }
  return { ok: true, accountName: name };
}

async function deleteAdmin(accountName, operator) {
  if (operator.role !== "super") return { ok: false, message: "仅超级管理员可删除管理员" };
  const name = String(accountName || "").trim();
  if (!name) return { ok: false, message: "缺少账号名" };
  if (name === operator.accountName) return { ok: false, message: "不能删除当前登录的账号" };
  const admins = await fetchAll(ADMINS);
  const target = admins.find(a => a.accountName === name);
  if (!target) return { ok: false, message: "该管理员账号不存在或为系统内置账号" };
  if (target.role === "super") {
    const superCount = admins.filter(a => a.role === "super").length;
    if (superCount <= 1) return { ok: false, message: "至少保留一个超级管理员" };
  }
  await db.collection(ADMINS).doc(target._id).remove();
  return { ok: true, accountName: name };
}

async function changeAdminPassword(accountName, newPassword, operator) {
  const name = String(accountName || "").trim();
  const pwd = String(newPassword || "");
  if (!name) return { ok: false, message: "缺少账号名" };
  if (pwd.length < 8 || pwd.length > 32) return { ok: false, message: "新密码需 8-32 位" };
  if (operator.role !== "super" && name !== operator.accountName) {
    return { ok: false, message: "仅超级管理员可修改他人密码" };
  }
  if (name === ADMIN_USERNAME) {
    return { ok: false, message: "系统内置管理员密码需在云函数环境变量中修改" };
  }
  const admins = await fetchAll(ADMINS);
  const target = admins.find(a => a.accountName === name);
  if (!target) return { ok: false, message: "该管理员账号不存在" };
  const salt = crypto.randomBytes(8).toString("hex");
  await db.collection(ADMINS).doc(target._id).update({
    passwordHash: sha256(pwd + salt),
    salt: salt,
    updatedAt: Date.now(),
  });
  return { ok: true, accountName: name };
}

/* =====================================================================
 * 评分/评论墙管理（anime_reviews）
 * -------------------------------------------------------------
 * 行结构：{ _id:"r_{animeId}_{type}_{ep|0}_{uid}", animeId, title,
 *          type:"open"|"final"|"ep", ep:"0"|集号, uid, nickname,
 *          score, comment, status:"normal"|"hidden", createdAt, updatedAt }
 * 集合规则 read=true / write=false：客户端只读，本云函数是唯一写通道。
 * ===================================================================== */
function rvRowId(animeId, type, ep, uid) {
  return "r_" + String(animeId) + "_" + String(type) + "_" + String(ep || "0") + "_" + String(uid);
}

function rvPick(res) {
  if (!res) return null;
  let d = res.data;
  if (Array.isArray(d)) d = d[0] || null;
  return d && typeof d === "object" ? d : null;
}

/* 从墙行对象取同源定位 key（animeId / 该行所属用户 uid / 维度与集数） */
function rvRowKeys(row) {
  const animeId = String((row && row.animeId) || "").trim();
  const uid = String((row && row.uid) || "").trim();
  const type = row && row.type === "ep" ? "ep" : (row && row.type === "final" ? "final" : "open");
  const ep = type === "ep" ? String(row.ep == null || row.ep === "" ? "0" : row.ep) : "0";
  return { animeId, uid, type, ep };
}

/* 从 user_anime 的整包 data 中摘除与某墙行同源的评分段：
 * open/final → 删除 scores[type]；ep → 删除 episodes[animeId].epScores[ep]。
 * 仅删除评分内容，追番状态（status）、单集观看进度等其余字段一律保留。
 * 返回是否发生了删除。 */
function rvStripFromData(data, animeId, type, ep) {
  if (!data || typeof data !== "object") return false;
  const rec = data[animeId];
  if (!rec || typeof rec !== "object") return false;
  let changed = false;
  if (type === "ep") {
    const eps = rec.episodes && rec.episodes[animeId];
    if (eps && typeof eps === "object" && eps.epScores && Object.prototype.hasOwnProperty.call(eps.epScores, String(ep))) {
      delete eps.epScores[String(ep)];
      changed = true;
      if (!Object.keys(eps.epScores).length) delete eps.epScores;
      if (!Object.keys(eps).length) delete rec.episodes[animeId];
    }
    if (rec.episodes && !Object.keys(rec.episodes).length) delete rec.episodes;
  } else if (rec.scores && Object.prototype.hasOwnProperty.call(rec.scores, type)) {
    delete rec.scores[type];
    changed = true;
    if (!Object.keys(rec.scores).length) delete rec.scores;
  }
  // 评分删空后若整条档案已无可保留字段，才移除该番条目（不影响仍收藏/在看的番）
  if (changed && !Object.keys(rec).length) delete data[animeId];
  return changed;
}

/* 管理端删除某条墙行时，反向联动删除对应用户个人档案（user_anime）里同源的评分段，
 * 让“管理后台删除同样影响个人端”，避免用户在详情页仍看到已下架的内容。
 * 兼容该用户存在多份身份文档（_openid / userId 两种写法）。返回清理成功的文档数。 */
async function rvSyncRemoveFromUser(row) {
  const { animeId, uid, type, ep } = rvRowKeys(row);
  if (!animeId || !uid) return 0;
  if (!/^D\d+$/.test(uid)) return 0; // 只有注册 D 账号的档案才可能有墙行来源
  const seen = new Set();
  let touched = 0;
  for (const q of [{ _openid: uid }, { userId: uid }]) {
    let docs = [];
    try {
      const res = await db.collection(USER_ANIME).where(q).limit(50).get();
      docs = (res && res.data) || [];
    } catch (e) {
      docs = [];
    }
    for (const doc of docs) {
      if (!doc || !doc._id || seen.has(doc._id)) continue;
      seen.add(doc._id);
      if (!doc.data || typeof doc.data !== "object") continue;
      if (rvStripFromData(doc.data, animeId, type, ep)) {
        try {
          await db.collection(USER_ANIME).doc(doc._id).update({ data: doc.data });
          touched++;
        } catch (e) {
          /* 单文档联动失败继续，不阻断墙的删除 */
        }
      }
    }
  }
  return touched;
}

/** 把 user_anime.data 展开为评论行候选（不含昵称，幂等 _id） */
function rvCandidates(uid, data) {
  const out = [];
  if (!data || typeof data !== "object") return out;
  const norm = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(Math.max(0, Math.min(10, n)) * 2) / 2;
  };
  const trimC = (v) => String(v || "").trim().slice(0, 200);
  for (const animeId of Object.keys(data)) {
    if (animeId.indexOf("_") === 0) continue;
    const rec = data[animeId];
    if (!rec || typeof rec !== "object") continue;
    const scores = rec.scores || {};
    const push = (type, ep, score, comment) => {
      if (!score && !comment) return;
      out.push({ _id: rvRowId(animeId, type, ep, uid), animeId, type, ep, uid, score: norm(score), comment });
    };
    if (scores.open) push("open", "0", scores.open.score, trimC(scores.open.comment));
    if (scores.final) push("final", "0", scores.final.score, trimC(scores.final.comment));
    const eps = (rec.episodes && rec.episodes[animeId] && rec.episodes[animeId].epScores) || {};
    const epNos = Object.keys(eps).sort((a, b) => Number(a) - Number(b));
    for (const ep of epNos) {
      const es = eps[ep];
      if (es) push("ep", String(ep), es.score, trimC(es.comment));
    }
  }
  return out;
}

async function reviewList(p) {
  p = p || {};
  const rows = await fetchAll(REVIEWS);
  const kw = String(p.keyword || "").trim().toLowerCase();
  const list = rows
    .filter((r) => {
      if (p.animeId && r.animeId !== p.animeId) return false;
      if (p.type && r.type !== p.type) return false;
      if (p.ep && String(r.ep) !== String(p.ep)) return false;
      if (p.status && r.status !== p.status) return false;
      if (p.uid && r.uid !== p.uid) return false;
      if (kw) {
        const hay = (String(r.comment || "") + " " + String(r.title || "") + " " + String(r.uid || "")).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const total = list.length;
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 30));
  return { ok: true, total, page, pageSize, list: list.slice((page - 1) * pageSize, page * pageSize) };
}

async function reviewStats() {
  const rows = await fetchAll(REVIEWS);
  const normal = rows.filter((r) => r.status !== "hidden");
  const hidden = rows.length - normal.length;

  const agg = {};
  const hist = {};
  const typeCount = { open: 0, final: 0, ep: 0 };
  const halfKey = (v) => String(Math.round(Number(v) * 2) / 2);

  for (const r of rows) {
    if (r.type && typeCount[r.type] !== undefined) typeCount[r.type]++;
  }
  for (const r of normal) {
    const a = agg[r.animeId] || (agg[r.animeId] = {
      animeId: r.animeId, title: r.title || "",
      open: 0, openSum: 0, final: 0, finalSum: 0, ep: 0, epSum: 0,
    });
    if (r.type === "open") { a.open++; a.openSum += r.score || 0; }
    else if (r.type === "final") { a.final++; a.finalSum += r.score || 0; }
    else { a.ep++; a.epSum += r.score || 0; }
    const hk = halfKey(r.score || 0);
    hist[hk] = (hist[hk] || 0) + 1;
  }

  const now = Date.now();
  const DAY = 86400000;
  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const days = {};
  for (let i = 29; i >= 0; i--) days[ymd(new Date(now - i * DAY))] = 0;
  for (const r of rows) {
    const t = r.updatedAt || r.createdAt || 0;
    if (t >= now - 30 * DAY) {
      const k = ymd(new Date(t));
      if (k in days) days[k]++;
    }
  }

  const anime = Object.values(agg)
    .map((a) => {
      a.openAvg = a.open ? Math.round((a.openSum / a.open) * 10) / 10 : null;
      a.finalAvg = a.final ? Math.round((a.finalSum / a.final) * 10) / 10 : null;
      a.epAvg = a.ep ? Math.round((a.epSum / a.ep) * 10) / 10 : null;
      a.total = a.open + a.final + a.ep;
      delete a.openSum; delete a.finalSum; delete a.epSum;
      return a;
    })
    .filter((a) => a.total > 0)
    .sort((x, y) => (y.finalAvg || 0) - (x.finalAvg || 0));

  const histSorted = Object.keys(hist).map(Number).sort((a, b) => a - b).map((k) => [k, hist[k]]);
  return {
    ok: true,
    overview: { total: rows.length, normal: normal.length, hidden },
    typeCount,
    hist: histSorted,
    recent30: days,
    anime,
  };
}

async function reviewSetStatus(id, status) {
  const col = db.collection(REVIEWS);
  const cur = await col.doc(id).get().catch(() => null);
  if (!rvPick(cur)) return { ok: false, message: "评论不存在" };
  await col.doc(id).update({ status, updatedAt: Date.now() });
  return { ok: true, _id: id, status };
}

async function reviewDeleteOne(id) {
  const col = db.collection(REVIEWS);
  const cur = await col.doc(id).get().catch(() => null);
  const row = rvPick(cur);
  if (!row) return { ok: false, message: "评论不存在" };
  await col.doc(id).remove();
  // 反向联动：把该用户个人档案里同源的那条评分/短评一并删除
  let userSynced = 0;
  try { userSynced = await rvSyncRemoveFromUser(row); } catch (e) { /* 联动失败不阻断主删除 */ }
  return { ok: true, _id: id, userSynced };
}

async function reviewClearAnime(animeId) {
  const col = db.collection(REVIEWS);
  const res = await col.where({ animeId }).get();
  const rows = (res && res.data) || [];
  let userSynced = 0;
  for (const r of rows) {
    if (!r || !r._id) continue;
    try { await col.doc(r._id).remove(); } catch (e) { /* 单条失败继续 */ }
    try { userSynced += await rvSyncRemoveFromUser(r); } catch (e) { /* 联动失败继续 */ }
  }
  return { ok: true, removed: rows.length, userSynced };
}

/** 全量回填：把 user_anime 中所有注册 D 账号的历史评分补齐成评论墙行（仅创建缺失行，幂等）。
 *  dryRun=true 仅扫描统计不写入，供管理端预览后二次确认。 */
async function reviewBackfill(dryRun) {
  const docs = await fetchAll(USER_ANIME);
  const targets = [];
  for (const d of docs) {
    if (!d || typeof d.data !== "object") continue;
    const uid = (d.userId && /^D\d+$/.test(d.userId)) ? d.userId
      : (/^D\d+$/.test(d._openid || "") ? d._openid : "");
    if (!uid) continue;
    const cands = rvCandidates(uid, d.data);
    if (!cands.length) continue;
    targets.push({ uid, cands });
  }
  const accts = await fetchAll(ACCOUNTS);
  const nick = {};
  for (const a of accts) if (a && a.uid) nick[a.uid] = a.nickname || "";

  const col = db.collection(REVIEWS);
  let created = 0, existed = 0, candidates = 0;
  for (const t of targets) {
    for (const c of t.cands) {
      candidates++;
      const cur = await col.doc(c._id).get().catch(() => null);
      if (rvPick(cur)) { existed++; continue; }
      if (dryRun) continue;
      const t0 = Date.now();
      await col.doc(c._id).set({
        animeId: c.animeId, title: c.title || "", type: c.type, ep: c.ep,
        uid: t.uid, nickname: nick[t.uid] || "",
        score: c.score, comment: c.comment,
        status: "normal", createdAt: t0, updatedAt: t0,
      });
      created++;
    }
  }
  return { ok: true, dryRun: !!dryRun, accounts: targets.length, candidates, created, existed };
}

/* =====================================================================
 * 用户反馈管理（feedback）
 * -------------------------------------------------------------
 * 文档结构：{ uid, nickname, type:"bug"|"suggestion"|"content"|"other",
 *             content, page, refTitle, refId,
 *             status:"new"|"done", createdAt, updatedAt }
 * 集合规则 read=false / write=false：客户端不可读写，仅云函数
 * （feedback_api 提交 + 本函数管理）。统计与列表均为全量拉取排序，
 * 反馈量级小，无需额外索引。
 * ===================================================================== */
async function feedbackStats() {
  const rows = await fetchAll(FEEDBACK);
  const byType = { bug: 0, suggestion: 0, content: 0, other: 0 };
  let pending = 0;
  for (const r of rows) {
    if (r && r.status !== "done") pending++;
    if (r && byType[r.type] !== undefined) byType[r.type]++;
  }
  return {
    ok: true,
    total: rows.length,
    pending,
    done: rows.length - pending,
    byType,
  };
}

async function feedbackList(p) {
  p = p || {};
  const rows = await fetchAll(FEEDBACK);
  const kw = String(p.keyword || "").trim().toLowerCase();
  const list = rows
    .filter((r) => {
      if (p.status && r.status !== p.status) return false;
      if (p.type && r.type !== p.type) return false;
      if (p.uid && String(r.uid) !== String(p.uid)) return false;
      if (kw) {
        const hay = String(
          (r.content || "") + " " + (r.nickname || "") + " " + (r.uid || "") +
          " " + (r.refTitle || "") + " " + (r.page || "")
        ).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    })
    .sort((a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
  const total = list.length;
  const page = Math.max(1, Number(p.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20));
  return { ok: true, total, page, pageSize, list: list.slice((page - 1) * pageSize, page * pageSize) };
}

async function feedbackMark(id, status) {
  const st = status === "done" ? "done" : status === "new" ? "new" : "";
  if (!st) return { ok: false, message: "状态不合法" };
  const col = db.collection(FEEDBACK);
  const cur = await col.doc(String(id)).get().catch(() => null);
  if (!rvPick(cur)) return { ok: false, message: "反馈不存在或已删除" };
  await col.doc(String(id)).update({ status: st, updatedAt: Date.now() });
  return { ok: true, _id: String(id), status: st };
}

async function feedbackDelete(id) {
  if (!id) return { ok: false, message: "缺少文档 ID" };
  const col = db.collection(FEEDBACK);
  const cur = await col.doc(String(id)).get().catch(() => null);
  if (!rvPick(cur)) return { ok: false, message: "反馈不存在或已删除" };
  await col.doc(String(id)).remove();
  return { ok: true, _id: String(id) };
}

/* =====================================================================
 * 站点配置 / 公告弹窗（site_config）  —— v2.1 新增功能
 * -------------------------------------------------------------
 * 单文档 doc("announcement")：
 *   { enabled:Boolean, content:String, updatedAt:Number, updatedBy:String }
 * 集合规则 read=true / write=false：前台各页（announcement.js）只读，
 * 写入只经本函数，客户端无法绕过鉴权。
 * 内容为纯文本（前台用 textContent 渲染，不做富文本，避免 XSS）。
 * ===================================================================== */
const CONFIG_DOC = "announcement";
const ANN_CONTENT_MAX = 2000;
const PRESET_DOC = "rating_presets";   // 评分室预设（v4.0）：单文档 { list: [...] }

async function configGet() {
  const res = await db.collection(SITE_CONFIG).doc(CONFIG_DOC).get().catch(() => null);
  const doc = res ? rvPick(res.data) : null;
  return {
    ok: true,
    config: {
      enabled: !!(doc && doc.enabled),
      content: String((doc && doc.content) || ""),
      updatedAt: Number((doc && doc.updatedAt) || 0),
      updatedBy: String((doc && doc.updatedBy) || ""),
    },
  };
}

async function configSave(p, admin) {
  p = p || {};
  const enabled = !!p.enabled;
  const content = String(p.content == null ? "" : p.content).trim();
  if (content.length > ANN_CONTENT_MAX) {
    return { ok: false, message: "公告内容最多 " + ANN_CONTENT_MAX + " 字" };
  }
  if (enabled && !content) {
    return { ok: false, message: "启用公告弹窗时，请先填写公告内容" };
  }
  const now = Date.now();
  const updatedBy = (admin && admin.accountName) || "";
  try {
    await db.collection(SITE_CONFIG).doc(CONFIG_DOC).set({
      enabled,
      content,
      updatedAt: now,
      updatedBy,
    });
  } catch (e) {
    return {
      ok: false,
      message: "保存失败：" + (e.message || e) + "（请确认环境已创建 site_config 集合，规则为「所有人可读、仅管理端可写」）",
    };
  }
  return { ok: true, config: { enabled, content, updatedAt: now, updatedBy } };
}

/* =====================================================================
 * 评分预设（v4.0）—— site_config 单文档 doc("rating_presets")
 *   { list: [{ name, config, updatedAt, updatedBy }] }
 * 前台 rating.html 直读该文档（集合 read=true），写入仅经本函数。
 * ===================================================================== */
async function readPresets() {
  const res = await db.collection(SITE_CONFIG).doc(PRESET_DOC).get().catch(() => null);
  const doc = res ? rvPick(res.data) : null;
  return (doc && Array.isArray(doc.list)) ? doc.list : [];
}

function sanitizePresetConfig(c) {
  c = c || {};
  const numArr = v => (Array.isArray(v) ? v.map(n => Number(n)).filter(n => !!n) : []);
  const strArr = v => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []);
  const modes = strArr(c.modes).filter(m => ["expect", "eps", "final"].includes(m));
  const ms = Number(c.maxScore);
  return {
    years: numArr(c.years),
    months: numArr(c.months),
    quarters: numArr(c.quarters),
    sources: strArr(c.sources),
    types: strArr(c.types),
    maxScore: [5, 10, 100].includes(ms) ? ms : 10,
    modes: modes.length ? modes : ["expect", "eps", "final"],
  };
}

async function presetList() {
  return { ok: true, list: await readPresets() };
}

async function presetSave(p, admin) {
  const name = String((p && p.name) || "").trim();
  if (!name) return { ok: false, message: "请填写预设名称" };
  if (name.length > 30) return { ok: false, message: "预设名称最多 30 字" };
  const cfg = sanitizePresetConfig(p.config);
  const list = await readPresets();
  if (list.length >= 50) return { ok: false, message: "预设最多 50 个，请先删除部分预设" };
  const idx = Number(p.index);
  const item = {
    name,
    config: cfg,
    updatedAt: Date.now(),
    updatedBy: (admin && admin.accountName) || "",
  };
  if (Number.isInteger(idx) && idx >= 0 && idx < list.length) list[idx] = item;
  else list.push(item);
  try {
    await db.collection(SITE_CONFIG).doc(PRESET_DOC).set({ list });
  } catch (e) {
    return { ok: false, message: "保存失败：" + (e.message || e) };
  }
  return { ok: true, list };
}

async function presetDelete(idx) {
  const i = Number(idx);
  const list = await readPresets();
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, message: "预设不存在" };
  list.splice(i, 1);
  try {
    await db.collection(SITE_CONFIG).doc(PRESET_DOC).set({ list });
  } catch (e) {
    return { ok: false, message: "删除失败：" + (e.message || e) };
  }
  return { ok: true, list };
}

exports.main = async (event) => {
  const { action = "login", username, password, data } = event || {};

  try {
    if (action === "login") {
      const admin = await findAdmin(username, password);
      if (!admin) return { ok: false, message: "账号或密码错误" };
      return { ok: true, accountName: admin.accountName, role: admin.role };
    }

    const admin = await findAdmin(username, password);
    if (!admin) return { ok: false, code: "AUTH_FAIL", message: "账号或密码错误" };

    switch (action) {
      case "save": {
        const body = sanitize(data || {});
        if (!body.id) return { ok: false, message: "缺少番剧 ID" };
        if (!body.title) return { ok: false, message: "缺少标题" };
        if (data && data._id) {
          await db.collection(COLL).doc(data._id).set(body);
        } else {
          await db.collection(COLL).add(body);
        }
        return { ok: true };
      }

      case "delete": {
        if (!data || !data._id) return { ok: false, message: "缺少文档 ID" };
        await db.collection(COLL).doc(data._id).remove();
        return { ok: true };
      }

      case "userList":
        return await listUsers();

      case "resetUserPassword":
        return await resetUserPassword(data && data.accountName);

      case "adminList":
        return await listAdmins();

      case "adminAdd":
        return await addAdmin(data && data.accountName, data && data.password, admin.role);

      case "adminDelete":
        return await deleteAdmin(data && data.accountName, admin);

      case "adminChangePassword":
        return await changeAdminPassword(data && data.accountName, data && data.password, admin);

      /* ---------- 用户反馈（feedback） ---------- */
      case "feedbackStats":
      case "feedbackList":
        return action === "feedbackStats" ? await feedbackStats() : await feedbackList(data || {});

      case "feedbackMark":
        return await feedbackMark(data && data._id, data && data.status);

      case "feedbackDelete":
        if (admin.role !== "super") return { ok: false, message: "仅超级管理员可删除反馈" };
        return await feedbackDelete(data && data._id);

      /* ---------- 站点配置：公告弹窗（site_config） ---------- */
      case "configGet":
        return await configGet();

      case "configSave":
        return await configSave(data || {}, admin);

      /* ---------- 评分预设（site_config · rating_presets） ---------- */
      case "presetList":
        return await presetList();

      case "presetSave":
        return await presetSave(data || {}, admin);

      case "presetDelete":
        return await presetDelete(data && data.index);

      /* ---------- 评分/评论墙（anime_reviews） ---------- */
      case "reviewList":
      case "reviewStats":
        return action === "reviewList" ? await reviewList(data || {}) : await reviewStats();

      case "reviewHide":
      case "reviewRestore":
      case "reviewDelete":
      case "reviewClearAnime":
      case "reviewBackfill":
        if (admin.role !== "super") return { ok: false, message: "仅超级管理员可隐藏/恢复/删除或回填评论" };
        if (action === "reviewHide") return await reviewSetStatus(data && data._id, "hidden");
        if (action === "reviewRestore") return await reviewSetStatus(data && data._id, "normal");
        if (action === "reviewDelete") return await reviewDeleteOne(data && data._id);
        if (action === "reviewClearAnime") return await reviewClearAnime(data && data.animeId);
        return await reviewBackfill(data && !!data.dryRun);

      default:
        return { ok: false, message: "未知操作：" + action };
    }
  } catch (e) {
    console.error("admin_api error:", e);
    return { ok: false, message: e.message || "操作失败" };
  }
};
