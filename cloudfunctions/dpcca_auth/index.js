/**
 * dpcca_auth - DPCCA 用户账号云函数（自定义账号密码 + 自定义登录 Ticket）
 * ------------------------------------------------------------
 * 功能：
 *   action=register          注册新账号：可选昵称、可选密保问题/答案 -> 分配业务 uid -> 签发 Ticket
 *   action=login             账号密码登录 -> 签发 Ticket
 *   action=getAccountInfo    按 uid 查询账号信息（accountName / nickname / hasSecret）
 *   action=setNickname       设置昵称（需登录态 uid 匹配）
 *   action=changePassword    修改密码（需原密码）
 *   action=getSecretQuestion 查询账号的密保问题（忘记密码第一步）
 *   action=setSecret         设置/修改密保问题（需当前密码）
 *   action=resetPassword     忘记密码：回答密保 -> 重设密码
 *
 * 账号名规则：2-20 位，中英文 + 数字 + 符号（半角 . _ @ - 与全角 ． ＠ ＿ －）
 *   （不能以符号开头/结尾、不允许连续符号）
 * 密码规则：8-32 位，字母、数字、符号任含其一即可
 *   （符号范围：半角 !@#$%^&*()_+-=[]{}|;:,.<>? 与全角 ！＠＃￥％＾＆＊（）＿＋－＝｛｝【】｜；：，。＜＞？、～）
 * 昵称规则：1-20 位，中英文、数字、空格及 - _ · .
 * 密保问题：2-100 字；密保答案：1-100 字（加盐哈希存储）
 *
 * 数据库：
 *   dpcca_accounts  账号表，文档 _id = "u_" + base64url(账号名)（天然唯一）
 *   dpcca_counters  序号计数器，文档 _id = "user_seq"，value 为已分配的最大序号（初始 100000）
 *
 * 客户端拿到 ticket 后调用 auth.signInWithTicket(ticket) 完成登录，
 * CloudBase 用户 uid 即业务 uid（如 D100000），
 * user_anime / user_profiles 等集合的安全规则直接按 _openid == auth.uid 隔离。
 */
const tcb = require("@cloudbase/node-sdk");
const crypto = require("crypto");

const ENV_ID = process.env.TCB_ENV || "dpcca-wiki-d7g0dl19y23cd30f3";
// 自定义登录私钥：签发 Ticket 必需（tcb_custom_login.json 为控制台「身份认证-自定义登录」生成的私钥）
let credentials = null;
try {
  credentials = require("./tcb_custom_login.json");
} catch (e) {
  console.error("load tcb_custom_login.json failed:", e.message, e.code);
}
if (credentials) {
  console.error("credentials keys:", Object.keys(credentials).join(","), "| pk_id:", String(credentials.private_key_id || "").slice(0, 8), "| env_id:", credentials.env_id);
} else {
  console.error("WARN: credentials is empty, createTicket will fail");
}
const app = tcb.init({ env: ENV_ID, credentials: credentials || undefined });
const db = app.database();

const ACCOUNTS = "dpcca_accounts";
const COUNTERS = "dpcca_counters";
const SEQ_DOC = "user_seq";
const SEQ_START = 100000; // 第一个 uid 为 D100000
const SEQ_END = 200000;   // uid 上限 D200000

// 账号名：中英文数字 + 半角/全角符号，中间可含符号，但首尾必须是字母/数字/中文
// 符号允许：半角 . _ @ - 与全角 ． ＠ ＿ －
const NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5](?:[A-Za-z0-9\u4e00-\u9fa5._@．＠＿－-]*[A-Za-z0-9\u4e00-\u9fa5])?$/;
// 密码符号：半角与全角均允许
const PWD_SYMBOL_RE = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?！＠＃￥％＾＆＊（）＿＋－＝｛｝【】｜；：，。＜＞？、～]/;
// 昵称：中英文、数字、空格及 - _ · .
const NICK_RE = /^[\u4e00-\u9fa5a-zA-Z0-9 _\-·.]{1,20}$/;

function validName(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 2 || n.length > 20) return false;
  if (/(?:[._@．＠＿－-]{2,})/.test(n)) return false; // 不允许连续符号
  return NAME_RE.test(n);
}

function validPassword(pwd) {
  if (typeof pwd !== "string") return false;
  if (pwd.length < 8 || pwd.length > 32) return false;
  // 字母 / 数字 / 符号 三者任含其一即可（不再强制组合）
  if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(pwd) && !PWD_SYMBOL_RE.test(pwd)) return false;
  return true;
}

function validNick(nick) {
  return typeof nick === "string" && NICK_RE.test(nick.trim());
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// 文档 _id：前缀 + base64url(账号名)，避免中文/特殊字符作为 _id 的兼容问题，且天然唯一
function docId(name) {
  return "u_" + Buffer.from(name, "utf8").toString("base64url");
}

function pick(doc) {
  if (!doc) return null;
  return Array.isArray(doc) ? doc[0] : doc;
}

// 客户端调用云函数时注入的登录用户标识：自定义登录为 customUserId/uid，匿名/微信为 openId
function callerUid(event) {
  const info = (event && event.userInfo) || {};
  let uid = String(info.customUserId || info.uid || info.openId || "");
  // 个别调用链路 event.userInfo 为空时，再尝试从服务端 auth 获取（自定义登录为 customUserId）
  if (!uid && app && typeof app.auth === "function") {
    try {
      const svr = app.auth().getUserInfo() || {};
      uid = String(svr.customUserId || svr.uid || svr.openId || "");
    } catch (e) { /* ignore */ }
  }
  return uid;
}

async function register(name, password, nickname, secretQuestion, secretAnswer) {
  // 1) 快速路径：账号是否已存在
  const exist = await db.collection(ACCOUNTS).doc(docId(name)).get();
  if (pick(exist.data)) return { ok: false, message: "该账号名已被注册，请换一个" };

  // 2) 事务分配 uid 序号（并发注册由事务冲突保证不重复）
  let next;
  const t = await db.startTransaction();
  try {
    const seqRes = await t.collection(COUNTERS).doc(SEQ_DOC).get();
    const seqDoc = pick(seqRes.data);
    const cur = seqDoc && typeof seqDoc.value === "number" ? seqDoc.value : SEQ_START - 1;
    next = cur + 1;
    if (next > SEQ_END) {
      await t.rollback();
      return { ok: false, message: "注册人数已达上限（D" + SEQ_END + "）" };
    }
    await t.collection(COUNTERS).doc(SEQ_DOC).set({ value: next, updatedAt: Date.now() });
    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (_) {}
    throw new Error("同时注册的用户太多，请重试");
  }

  // 3) 写账号（doc().create() 仅在文档不存在时创建，避免并发同名覆盖）
  const salt = crypto.randomBytes(8).toString("hex");
  const uid = "D" + next;
  const account = {
    accountName: name,
    uid: uid,
    passwordHash: sha256(password + salt),
    salt: salt,
    nickname: (nickname || "").trim(),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    status: "active",
  };
  // 可选密保：答案加盐哈希存储
  if (secretQuestion && secretAnswer) {
    const secretSalt = crypto.randomBytes(8).toString("hex");
    account.secretQuestion = secretQuestion.trim();
    account.secretAnswerHash = sha256(secretAnswer.trim() + secretSalt);
    account.secretSalt = secretSalt;
  }
  try {
    await db.collection(ACCOUNTS).doc(docId(name)).create(account);
  } catch (e) {
    return { ok: false, message: "该账号名已被注册，请换一个" };
  }

  const ticket = app.auth().createTicket(uid);
  return { ok: true, ticket: ticket, uid: uid, accountName: name, isNew: true };
}

async function login(name, password) {
  const res = await db.collection(ACCOUNTS).doc(docId(name)).get();
  const doc = pick(res.data);
  if (!doc || doc.status !== "active") return { ok: false, message: "账号不存在或已被停用" };
  if (sha256(password + doc.salt) !== doc.passwordHash) return { ok: false, message: "密码错误" };
  try { await db.collection(ACCOUNTS).doc(docId(name)).update({ lastLoginAt: Date.now() }); } catch (_) {}
  const ticket = app.auth().createTicket(doc.uid);
  return { ok: true, ticket: ticket, uid: doc.uid, accountName: doc.accountName, nickname: doc.nickname || "" };
}

async function getAccountInfo(uid) {
  const res = await db.collection(ACCOUNTS).where({ uid }).get();
  const doc = pick(res.data);
  if (!doc) return { ok: false, message: "账号不存在" };
  return {
    ok: true,
    account: {
      uid: doc.uid,
      accountName: doc.accountName,
      nickname: doc.nickname || "",
      hasSecret: !!(doc.secretQuestion && doc.secretAnswerHash),
    },
  };
}

async function setNickname(uid, nickname, event) {
  // 已登录调用时校验调用者 uid 与目标 uid 一致；event.userInfo 缺失时放行（兼容直调）
  const cu = callerUid(event);
  if (cu && cu !== uid) return { ok: false, message: "身份校验失败，请重新登录" };
  const nick = (nickname || "").trim();
  if (!validNick(nick)) return { ok: false, message: "昵称需 1-20 位，仅限中英文、数字、空格及 - _ · ." };
  const res = await db.collection(ACCOUNTS).where({ uid }).get();
  const doc = pick(res.data);
  if (!doc) return { ok: false, message: "账号不存在" };
  await db.collection(ACCOUNTS).doc(doc._id).update({ nickname: nick, updatedAt: Date.now() });
  return { ok: true, nickname: nick };
}

async function changePassword(name, oldPassword, newPassword) {
  const res = await db.collection(ACCOUNTS).doc(docId(name)).get();
  const doc = pick(res.data);
  if (!doc || doc.status !== "active") return { ok: false, message: "账号不存在或已被停用" };
  if (!oldPassword || sha256(oldPassword + doc.salt) !== doc.passwordHash) return { ok: false, message: "原密码错误" };
  if (!validPassword(newPassword)) return { ok: false, message: "新密码需 8-32 位，字母、数字、符号任含其一即可" };
  const salt = crypto.randomBytes(8).toString("hex");
  await db.collection(ACCOUNTS).doc(docId(name)).update({
    passwordHash: sha256(newPassword + salt),
    salt: salt,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

async function getSecretQuestion(name) {
  const res = await db.collection(ACCOUNTS).doc(docId(name)).get();
  const doc = pick(res.data);
  if (!doc || doc.status !== "active") return { ok: false, message: "账号不存在" };
  if (!doc.secretQuestion || !doc.secretAnswerHash) {
    return { ok: false, code: "NO_SECRET", message: "该账号未设置密保问题，无法通过密保找回密码" };
  }
  return { ok: true, question: doc.secretQuestion };
}

async function setSecret(name, password, question, answer) {
  const q = (question || "").trim();
  const a = (answer || "").trim();
  if (q.length < 2 || q.length > 100) return { ok: false, message: "密保问题需 2-100 字" };
  if (a.length < 1 || a.length > 100) return { ok: false, message: "密保答案需 1-100 字" };
  const res = await db.collection(ACCOUNTS).doc(docId(name)).get();
  const doc = pick(res.data);
  if (!doc || doc.status !== "active") return { ok: false, message: "账号不存在或已被停用" };
  if (!password || sha256(password + doc.salt) !== doc.passwordHash) return { ok: false, message: "当前密码错误" };
  const secretSalt = crypto.randomBytes(8).toString("hex");
  await db.collection(ACCOUNTS).doc(docId(name)).update({
    secretQuestion: q,
    secretAnswerHash: sha256(a + secretSalt),
    secretSalt: secretSalt,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

async function resetPassword(name, question, answer, newPassword) {
  const res = await db.collection(ACCOUNTS).doc(docId(name)).get();
  const doc = pick(res.data);
  if (!doc || doc.status !== "active") return { ok: false, message: "账号不存在或已被停用" };
  if (!doc.secretQuestion || !doc.secretAnswerHash) {
    return { ok: false, code: "NO_SECRET", message: "该账号未设置密保问题，无法通过密保找回密码" };
  }
  if ((question || "").trim() !== doc.secretQuestion) return { ok: false, message: "密保问题不匹配" };
  if (sha256((answer || "").trim() + doc.secretSalt) !== doc.secretAnswerHash) return { ok: false, message: "密保答案错误" };
  if (!validPassword(newPassword)) return { ok: false, message: "新密码需 8-32 位，字母、数字、符号任含其一即可" };
  const salt = crypto.randomBytes(8).toString("hex");
  await db.collection(ACCOUNTS).doc(docId(name)).update({
    passwordHash: sha256(newPassword + salt),
    salt: salt,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

exports.main = async (event) => {
  const { action, accountName, password } = event || {};
  try {
    if (action === "register") {
      const name = (accountName || "").trim();
      if (!validName(name)) return { ok: false, message: "账号名需 2-20 位，仅限中英文、数字与符号（. _ @ - 等，半角全角均可），且不能以符号开头或结尾" };
      if (!validPassword(password)) return { ok: false, message: "密码需 8-32 位，字母、数字、符号任含其一即可" };
      const nick = event.nickname || "";
      if (nick && !validNick(nick)) return { ok: false, message: "昵称需 1-20 位，仅限中英文、数字、空格及 - _ · ." };
      const q = (event.secretQuestion || "").trim();
      const a = (event.secretAnswer || "").trim();
      if (q && !a) return { ok: false, message: "已填写密保问题，请同时填写密保答案" };
      if (a && !q) return { ok: false, message: "已填写密保答案，请同时填写密保问题" };
      if (q && (q.length < 2 || q.length > 100)) return { ok: false, message: "密保问题需 2-100 字" };
      if (a && (a.length < 1 || a.length > 100)) return { ok: false, message: "密保答案需 1-100 字" };
      return await register(name, password, nick, q || "", a || "");
    }
    if (action === "login") {
      const name = (accountName || "").trim();
      if (!name || !password) return { ok: false, message: "请输入账号名和密码" };
      return await login(name, password);
    }
    if (action === "getAccountInfo") {
      const uid = (event.uid || "").trim();
      if (!uid) return { ok: false, message: "缺少 uid" };
      return await getAccountInfo(uid);
    }
    if (action === "setNickname") {
      const uid = (event.uid || "").trim();
      if (!uid) return { ok: false, message: "缺少 uid" };
      return await setNickname(uid, event.nickname || "", event);
    }
    if (action === "changePassword") {
      const name = (accountName || "").trim();
      if (!name) return { ok: false, message: "缺少账号名" };
      return await changePassword(name, event.oldPassword || "", event.newPassword || "");
    }
    if (action === "getSecretQuestion") {
      const name = (accountName || "").trim();
      if (!name) return { ok: false, message: "请输入账号名" };
      return await getSecretQuestion(name);
    }
    if (action === "setSecret") {
      const name = (accountName || "").trim();
      if (!name) return { ok: false, message: "缺少账号名" };
      return await setSecret(name, event.password || "", event.question || "", event.answer || "");
    }
    if (action === "resetPassword") {
      const name = (accountName || "").trim();
      if (!name) return { ok: false, message: "请输入账号名" };
      return await resetPassword(name, event.question || "", event.answer || "", event.newPassword || "");
    }
    return { ok: false, message: "未知操作：" + action };
  } catch (e) {
    console.error("dpcca_auth error:", e);
    return { ok: false, message: e.message || "服务异常，请稍后再试" };
  }
};
