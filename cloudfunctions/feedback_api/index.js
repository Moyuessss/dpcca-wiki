/**
 * feedback_api - DPCCA 用户反馈提交接口（云函数）
 * ------------------------------------------------------------
 * 背景：feedback 集合安全规则 read=false, write=false，客户端不可直接
 * 读写；所有写入仅经本云函数（服务端特权直连）。
 *
 * 仅接受已登录的注册 D 账号（uid 形如 D100001）调用：
 *   - 游客（匿名 openid）/未登录一律拒绝，保证每条反馈可追溯到账号。
 *
 * 支持动作：
 *   action=submit  提交一条反馈
 *     data.type    bug|suggestion|content|other（必填）
 *     data.content 反馈正文，10-500 字（必填）
 *     data.page    来源页面（可选，如 /rating.html）
 *     data.refTitle / data.refId  关联番剧标题 / id（可选，
 *                  番剧详情内「数据有误」发起的反馈会自动带上）
 *
 * 限流（服务端校验，防刷屏）：
 *   - 同一 uid 两次提交间隔 >= 60s
 *   - 同一 uid 每个自然日最多 10 条
 *
 * 管理端查看 / 处理（feedbackStats / feedbackList / feedbackMark /
 * feedbackDelete）统一在 admin_login 云函数内，见其 feedback* action。
 *
 * 文档结构（feedback）：
 *   { uid, nickname, type:"bug"|"suggestion"|"content"|"other",
 *     content, page, refTitle, refId,
 *     status:"new"|"done", createdAt, updatedAt }
 */
const tcb = require("@cloudbase/node-sdk");

const ENV_ID = process.env.TCB_ENV || "dpcca-wiki-d7g0dl19y23cd30f3";
const app = tcb.init({ env: ENV_ID });
const db = app.database();
const _ = db.command;

const FEEDBACK = "feedback";
const ACCOUNTS = "dpcca_accounts";

const TYPE_SET = { bug: 1, suggestion: 1, content: 1, other: 1 };

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

async function getNickname(uid) {
  try {
    const res = await db.collection(ACCOUNTS).where({ uid }).get();
    const doc = pick(res);
    return (doc && doc.nickname) || "";
  } catch (e) {
    return "";
  }
}

/** 限流：距上次提交 >=60s，且当日未超上限。返回 { ok } 或 { ok:false, message } */
async function checkRateLimit(uid, now) {
  now = now || Date.now();
  const col = db.collection(FEEDBACK);
  try {
    const cnt = await col.where({ uid, createdAt: _.gt(now - 60000) }).count();
    if (cnt && cnt.total > 0) {
      return { ok: false, message: "提交过于频繁，请 1 分钟后再试" };
    }
  } catch (e) { /* 查询失败放行，不阻断主流程 */ }
  try {
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    const day = await col.where({ uid, createdAt: _.gte(d0.getTime()) }).count();
    if (day && day.total >= 10) {
      return { ok: false, message: "今日反馈次数已达上限（10 条），请明天再试" };
    }
  } catch (e) { /* ignore */ }
  return { ok: true };
}

async function submit(uid, data) {
  const type = String((data && data.type) || "").trim();
  const content = String((data && data.content) || "").trim();
  if (!TYPE_SET[type]) return { ok: false, message: "请选择反馈类型" };
  if (content.length < 10) return { ok: false, message: "反馈内容请至少写 10 个字" };
  if (content.length > 500) return { ok: false, message: "反馈内容最多 500 个字" };
  const limit = await checkRateLimit(uid);
  if (!limit.ok) return { ok: false, code: "RATE_LIMIT", message: limit.message };

  const nickname = await getNickname(uid);
  const now = Date.now();
  const doc = {
    uid: String(uid),
    nickname: nickname || "",
    type,
    content,
    page: String((data && data.page) || "").trim().slice(0, 300),
    refTitle: String((data && data.refTitle) || "").trim().slice(0, 120),
    refId: String((data && data.refId) || "").trim().slice(0, 40),
    status: "new",
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection(FEEDBACK).add(doc);
  return { ok: true, _id: (res && res.id) || "" };
}

exports.main = async (event) => {
  const { action, data } = event || {};
  const uid = callerUid(event);

  try {
    // 游客 / 未登录：一律拒绝
    if (!/^D\d+$/.test(uid)) {
      return { ok: false, code: "NEED_ACCOUNT", message: "请先注册并登录 D 账号后再提交反馈" };
    }

    switch (action) {
      case "submit":
        return await submit(uid, data || {});
      default:
        return { ok: false, message: "未知操作：" + action };
    }
  } catch (e) {
    console.error("feedback_api error:", e);
    return { ok: false, message: e.message || "操作失败" };
  }
};
