/**
 * reviews_api - DPCCA 公开评分/评论墙上行接口（云函数）
 * ------------------------------------------------------------
 * 背景：anime_reviews 集合安全规则 read=true, write=false，
 * 客户端只读；所有“上墙/下墙”写操作必须经本函数（服务端特权直连）。
 *
 * 仅接受已登录的注册 D 账号（uid 形如 D100001）调用：
 *   - 游客（匿名 openid）直接拒绝，保证评论墙只有注册用户数据。
 *
 * 支持的动作（data 为参数体）：
 *   action=upsert      提交/更新某番剧某维度的评分短评（score<=0 且无评论 → 删除该行）
 *   action=clearAnime  删除本人对某番剧的全部评论行（追番清单删除整剧时调用）
 *   action=rebuild     按本人 user_anime 全量镜像：补齐缺失行、更新内容不一致行、
 *                      清理已不在档案中的孤儿行（保留管理端 hidden 状态）
 *   action=epStats     （v4.0.1）全站单集评分统计（匿名可访问，纯只读聚合）：
 *                      入参 { animeId }，返回每集平均分/参评人数/总平均分
 *
 * 行文档（anime_reviews）：
 *   _id = "r_{animeId}_{type}_{ep|0}_{uid}"（幂等、可推导）
 *   { animeId, title, type:"open"|"final"|"ep", ep:"0"|集号,
 *     uid, nickname, score, comment,
 *     wall:true,        // 兼容保留字段；现行展示只看 status=normal
 *     status:"normal"|"hidden",
 *     createdAt, updatedAt }
 *
 * 三端同步语义：个人档案（user_anime）为唯一事实源；公开墙与管理后台均读
 * anime_reviews。个人端保存/删除评分时经 upsert/clearAnime 同步墙行，
 * rebuild 负责把历史不一致自愈为三端一致。
 */
const tcb = require("@cloudbase/node-sdk");

const ENV_ID = process.env.TCB_ENV || "dpcca-wiki-d7g0dl19y23cd30f3";
const app = tcb.init({ env: ENV_ID });
const db = app.database();

const REVIEWS = "anime_reviews";
const USER_ANIME = "user_anime";
const ACCOUNTS = "dpcca_accounts";

const TYPE_SET = { open: 1, final: 1, ep: 1 };

function pick(res) {
  if (!res) return null;
  let d = res.data;
  if (Array.isArray(d)) d = d[0] || null;
  return d && typeof d === "object" ? d : null;
}

/** 客户端调用云函数时注入的登录用户标识：自定义登录为 customUserId/uid，匿名/微信为 openId */
function callerUid(event) {
  const info = (event && event.userInfo) || {};
  let uid = String(info.customUserId || info.uid || info.openId || "");
  // 某些调用链路 event.userInfo 为空，尝试从服务端 auth 再取一次（自定义登录为 customUserId）
  if (!uid && app && typeof app.auth === "function") {
    try {
      const svr = app.auth().getUserInfo() || {};
      uid = String(svr.customUserId || svr.uid || svr.openId || "");
    } catch (e) { /* ignore */ }
  }
  return uid;
}

/** 行的幂等 _id */
function rowId(animeId, type, ep, uid) {
  return "r_" + String(animeId) + "_" + String(type) + "_" + String(ep || "0") + "_" + String(uid);
}

async function getNickname(uid) {
  try {
    const res = await db.collection(ACCOUNTS).where({ uid }).get();
    const doc = pick(res);
    return (doc && doc.nickname) || "";
  } catch (e) {
    return "";
  }
}

function normalizeNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(10, n)) * 2) / 2;
}

/* 把 user_anime 的整包 data 展开成待上墙候选行（不做写操作，返回候选数组） */
function buildCandidates(userDoc, nickname) {
  const out = [];
  const data = (userDoc && userDoc.data) || {};
  if (typeof data !== "object") return out;
  for (const animeId of Object.keys(data)) {
    const rec = data[animeId] || {};
    if (!rec || typeof rec !== "object" || animeId.indexOf("_") === 0) continue;
    const scores = rec.scores || {};
    if (scores.open && (scores.open.score || (scores.open.comment || "").trim())) {
      out.push({
        animeId, type: "open", ep: "0",
        score: normalizeNum(scores.open.score),
        comment: String(scores.open.comment || "").trim().slice(0, 200),
      });
    }
    if (scores.final && (scores.final.score || (scores.final.comment || "").trim())) {
      out.push({
        animeId, type: "final", ep: "0",
        score: normalizeNum(scores.final.score),
        comment: String(scores.final.comment || "").trim().slice(0, 200),
      });
    }
    const eps = (rec.episodes && rec.episodes[animeId] && rec.episodes[animeId].epScores) || {};
    for (const epNo of Object.keys(eps)) {
      const es = eps[epNo];
      if (es && (es.score || (es.comment || "").trim())) {
        out.push({
          animeId, type: "ep", ep: String(epNo),
          score: normalizeNum(es.score),
          comment: String(es.comment || "").trim().slice(0, 200),
        });
      }
    }
  }
  return out.map(c => ({
    _id: rowId(c.animeId, c.type, c.ep, userDoc.uidKey || userDoc.uid),
    animeId: c.animeId,
    type: c.type,
    ep: c.ep,
    uid: userDoc.uidKey || userDoc.uid,
    nickname: nickname || "",
    score: c.score,
    comment: c.comment,
  }));
}

/* 读取某 uid 的 user_anime 身份文档（_openid 优先，userId 兜底兼容早期数据） */
async function findUserDoc(uid) {
  const qs = [{ _openid: uid }, { userId: uid }];
  for (const q of qs) {
    try {
      const res = await db.collection(USER_ANIME).where(q).get();
      const list = (res && res.data) || [];
      const doc = list.find(x => x && x.data && typeof x.data === "object" && Object.keys(x.data).length) || list[0];
      if (doc) return doc;
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------------- action 实现 ---------------- */

/** 上墙/更新某一行。score<=0 且无评论 → 移除该行（评分被清空不应留在墙上） */
async function upsert(uid, data) {
  const animeId = String((data && data.animeId) || "").trim();
  const type = String((data && data.type) || "");
  if (!animeId || !TYPE_SET[type]) return { ok: false, message: "参数不合法" };
  const ep = type === "ep" ? String(data.ep || "") : "0";
  if (type === "ep" && !ep) return { ok: false, message: "缺少集数" };
  const score = normalizeNum(data.score);
  const comment = String(data.comment || "").trim().slice(0, 200);
  const title = String(data.title || "").trim().slice(0, 80);
  const id = rowId(animeId, type, ep, uid);

  if (score <= 0 && !comment) {
    // 无实质内容 → 删除该墙行（个人端删除评分时同步）
    await db.collection(REVIEWS).doc(id).remove().catch(() => null);
    return { ok: true, removed: true };
  }

  const nickname = await getNickname(uid);
  const exist = await db.collection(REVIEWS).doc(id).get().catch(() => null);
  const cur = pick(exist);
  const wall = true; // 兼容保留字段：现行展示只看 status=normal
  const now = Date.now();
  if (cur && cur._id) {
    // 用户主动重新提交 → 内容/分数以最新为准，status 恢复 normal（违规内容可被后台再次处理）
    await db.collection(REVIEWS).doc(id).update({
      title, nickname, score, comment, wall, status: "normal", updatedAt: now,
    });
  } else {
    await db.collection(REVIEWS).doc(id).set({
      animeId, title, type, ep, uid, nickname, score, comment, wall,
      status: "normal", createdAt: now, updatedAt: now,
    });
  }
  return { ok: true, _id: id };
}

/** 删除本人某番剧的全部评论行（open/final/各单集） */
async function clearAnime(uid, animeId) {
  const id = String((animeId || "")).trim();
  if (!id) return { ok: false, message: "缺少番剧 ID" };
  const col = db.collection(REVIEWS);
  let removed = 0;
  try {
    const res = await col.where({ animeId: id, uid }).get();
    const rows = (res && res.data) || [];
    for (const r of rows) {
      if (r && r._id) {
        try { await col.doc(r._id).remove(); removed++; } catch (e) { /* 单条失败继续 */ }
      }
    }
  } catch (e) { /* 集合不存在视为空 */ }
  return { ok: true, removed };
}

/* 读取某 uid 在 anime_reviews 的全部行（含 hidden） */
async function fetchRowsByUid(uid) {
  try {
    const res = await db.collection(REVIEWS).where({ uid }).limit(1000).get();
    return (res && res.data) || [];
  } catch (e) { return []; }
}

/** 本人全量镜像：以 user_anime 为唯一事实源，保证 anime_reviews 与个人档案完全一致。
 *  - 缺失行 → 创建（status=normal）
 *  - 内容/分数不一致 → 更新（保留管理端 hidden 状态）
 *  - 档案中已不存在（如个人端已删除但此前推送失败）→ 删除孤儿行 */
async function rebuild(uid) {
  const col = db.collection(REVIEWS);
  const now = Date.now();
  const userDoc = await findUserDoc(uid);
  if (!userDoc) {
    let pruned = 0;
    for (const r of await fetchRowsByUid(uid)) {
      if (r && r._id) { try { await col.doc(r._id).remove(); pruned++; } catch (e) { /* 单条失败继续 */ } }
    }
    return { ok: true, created: 0, updated: 0, existed: 0, pruned };
  }
  const nickname = await getNickname(uid);
  const cands = buildCandidates(Object.assign({}, userDoc, { uidKey: uid }), nickname);
  const candMap = {};
  cands.forEach(c => { candMap[c._id] = c; });
  let created = 0, updated = 0, existed = 0;
  for (const c of cands) {
    const exist = await col.doc(c._id).get().catch(() => null);
    const cur = pick(exist);
    if (!cur || !cur._id) {
      await col.doc(c._id).set({
        animeId: c.animeId, title: c.title || "", type: c.type, ep: c.ep,
        uid, nickname, score: c.score, comment: c.comment,
        wall: true, status: "normal", createdAt: now, updatedAt: now,
      });
      created++;
      continue;
    }
    if (cur.score !== c.score || (cur.comment || "") !== c.comment || (cur.nickname || "") !== nickname) {
      // 内容以个人档案最新为准；status 保持原样（hidden 由管理端控制）
      await col.doc(c._id).update({
        title: c.title || "", nickname, score: c.score, comment: c.comment, updatedAt: now,
      });
      updated++;
    } else {
      existed++;
    }
  }
  let pruned = 0;
  for (const r of await fetchRowsByUid(uid)) {
    if (r && r._id && !candMap[r._id]) {
      try { await col.doc(r._id).remove(); pruned++; } catch (e) { /* 单条失败继续 */ }
    }
  }
  return { ok: true, created, updated, existed, pruned };
}

/* ============================================================
 * v4.0.1 新增：epStats —— 单集评分全站统计（只读聚合，匿名可访问）
 * 汇总 user_anime 中所有用户对某番剧各集的 epScores：
 *   每集平均分 / 每集参评人数 / 总参评人数 / 总平均分
 * 纯公开统计（不含评论内容/身份），置于 D 账号拦截之前。
 * ============================================================ */
async function epStats(p) {
  const animeId = String((p && p.animeId) || "").trim();
  if (!animeId) return { ok: false, message: "缺少 animeId" };

  const epSum = {}, epCnt = {};
  let users = 0, totalSum = 0, totalCnt = 0, scanned = 0;
  let skip = 0;
  while (true) {
    const res = await db.collection(USER_ANIME).skip(skip).limit(100).get().catch(() => null);
    const rows = (res && res.data) || [];
    for (const u of rows) {
      const eps = u && u.data && u.data[animeId] && u.data[animeId].episodes
        && u.data[animeId].episodes[animeId] && u.data[animeId].episodes[animeId].epScores;
      if (!eps) continue;
      let userHas = false;
      Object.keys(eps).forEach(ep => {
        const sc = eps[ep] && Number(eps[ep].score);
        if (!sc || sc <= 0) return;
        epSum[ep] = (epSum[ep] || 0) + sc;
        epCnt[ep] = (epCnt[ep] || 0) + 1;
        totalSum += sc;
        totalCnt++;
        userHas = true;
      });
      if (userHas) users++;
    }
    scanned += rows.length;
    if (rows.length < 100 || scanned >= 20000) break;   // 防御性上限
    skip += 100;
  }

  const epAvg = {};
  Object.keys(epSum).forEach(ep => { epAvg[ep] = +(epSum[ep] / epCnt[ep]).toFixed(1); });
  return {
    ok: true,
    stats: {
      animeId,
      users,                                   // 至少为一集打分的用户数
      epAvg,                                   // { 集号: 平均分（1 位小数） }
      epCnt,                                   // { 集号: 参评人数 }
      avg: totalCnt ? +(totalSum / totalCnt).toFixed(1) : 0,   // 总平均分
      eps: totalCnt,                            // 已评（人·集）总数
    },
  };
}

exports.main = async (event) => {
  const { action, data } = event || {};
  const uid = callerUid(event);

  try {
    // v4.0.1：全站单集评分统计只读接口，匿名可访问（早于 D 账号拦截）
    if (action === "epStats") return await epStats(data || {});

    // 游客 / 未登录：一律拒绝（评论墙仅收录注册 D 账号）
    if (!/^D\d+$/.test(uid)) {
      return { ok: false, code: "NEED_ACCOUNT", message: "请先注册并登录 D 账号后再参与评论墙" };
    }

    switch (action) {
      case "upsert":
        return await upsert(uid, data || {});
      case "clearAnime":
        return await clearAnime(uid, data && data.animeId);
      case "rebuild":
        return await rebuild(uid);
      default:
        return { ok: false, message: "未知操作：" + action };
    }
  } catch (e) {
    console.error("reviews_api error:", e);
    return { ok: false, message: e.message || "操作失败" };
  }
};
