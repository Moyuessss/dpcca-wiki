/* ============================================================
 * DPCCA 账号系统 v3
 * 游客模式（匿名登录）+ 自定义账号密码（注册/登录）
 * 昵称 / 修改密码 / 密保问题 / 忘记密码
 * ------------------------------------------------------------
 * 依赖：window.cloudbase（SDK 2.32.0）、window.dataProvider（页面数据层）
 * 用法：在 <head> 引入 <script src="auth.js"></script>，
 *       DOMContentLoaded 后自动在右下角挂载登录按钮与面板；
 *       页面存在 #dpccaAccountPanel 容器时，自动渲染「个人账号卡片」。
 * 说明：
 *  - 匿名游客数据保存在本机 + 云端匿名 uid 文档；
 *  - 注册/登录：云函数 dpcca_auth 校验账号密码并分配业务 uid
 *    （D100000 起按序分配），签发自定义登录 Ticket；
 *  - 客户端通过 setCustomSignFunc + signInWithCustomTicket 登录，
 *    CloudBase 用户 uid 即业务 uid（如 D100001），数据按 _openid 隔离；
 *  - 注册时可选择是否把游客数据同步到新账号 uid 下；登录不迁移游客数据；
 *  - 注册时可选择设置密保问题（不强制）；已登录用户可在个人账号卡片
 *    设置/修改密保，用于忘记密码时找回。
 * ============================================================ */
(function () {
  if (window.DpccaAuth) return;

  var _auth = null;
  var LS_NAME = "dpcca_account_name";
  var LS_UID = "dpcca_account_uid";
  var LS_NICK = "dpcca_account_nick";

  /* ---------- 前端校验规则（与云函数 dpcca_auth 保持一致） ---------- */
  // 账号名符号：半角 . _ @ - 与全角 ． ＠ ＿ － 均允许
  var NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5](?:[A-Za-z0-9\u4e00-\u9fa5._@．＠＿－-]*[A-Za-z0-9\u4e00-\u9fa5])?$/;
  // 密码符号：半角与全角均允许
  var PWD_SYMBOL_RE = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?！＠＃￥％＾＆＊（）＿＋－＝｛｝【】｜；：，。＜＞？、～]/;
  // 昵称：中英文、数字、空格及 - _ · .
  var NICK_RE = /^[\u4e00-\u9fa5a-zA-Z0-9 _\-·.]{1,20}$/;

  function validName(n) {
    if (typeof n !== "string") return false;
    n = n.trim();
    if (n.length < 2 || n.length > 20) return false;
    if (/(?:[._@．＠＿－-]{2,})/.test(n)) return false; // 不允许连续符号
    return NAME_RE.test(n);
  }

  function validPassword(p) {
    if (typeof p !== "string") return false;
    if (p.length < 8 || p.length > 32) return false;
    // 字母 / 数字 / 符号 三者任含其一即可（不再强制组合）
    if (!/[a-zA-Z0-9\u4e00-\u9fa5]/.test(p) && !PWD_SYMBOL_RE.test(p)) return false;
    return true;
  }

  function validNick(nick) {
    return typeof nick === "string" && NICK_RE.test(nick.trim());
  }

  function $(id) { return document.getElementById(id); }

  function toast(msg, isErr) {
    if (typeof window.toast === "function") { window.toast(msg, isErr); return; }
    if (typeof alert === "function") alert(msg);
  }

  /* ---------- 内部：获取 auth 实例（复用页面 dataProvider 的 app/auth，保证同一登录态） ---------- */
  async function getAuth() {
    if (_auth) return _auth;
    if (typeof dataProvider !== "undefined" && dataProvider._cloud && typeof dataProvider._cloud._getDB === "function") {
      await dataProvider._cloud._getDB();
      _auth = dataProvider._cloud._auth;
      return _auth;
    }
    throw new Error("数据层未初始化");
  }

  /* ---------- 内部：获取 app 实例（调用云函数） ---------- */
  function getApp() {
    if (typeof dataProvider !== "undefined" && dataProvider._cloud) return dataProvider._cloud._app;
    return null;
  }

  /* ---------- 内部：登录前读取当前（游客）数据 ---------- */
  async function loadGuestData() {
    try {
      var data = await dataProvider.loadUserData();
      if (data && typeof data === "object" && Object.keys(data).length > 0) return data;
    } catch (e) {}
    return null;
  }

  /* ---------- 内部：把游客数据写入新账号（登录后调用） ---------- */
  async function migrateData(guestData) {
    if (!guestData) return;
    try {
      await dataProvider.saveUserData(guestData);
    } catch (e) {
      console.error("数据迁移失败", e);
    }
  }

  /* ---------- 内部：调用 dpcca_auth 云函数 ---------- */
  async function callAuth(action, payload) {
    var app = getApp();
    if (!app || typeof app.callFunction !== "function") throw new Error("云函数调用不可用");
    var data = { action: action };
    if (payload && typeof payload === "object") {
      for (var k in payload) data[k] = payload[k];
    }
    var res = await app.callFunction({ name: "dpcca_auth", data: data });
    var result = (res && res.result) || {};
    if (!result.ok) {
      var err = new Error(result.message || "操作失败");
      err.code = result.code;
      throw err;
    }
    return result;
  }

  /* ---------- 内部：用 Ticket 完成自定义登录 ---------- */
  async function signInWithTicket(ticket) {
    var auth = await getAuth();
    if (auth && typeof auth.setCustomSignFunc === "function" && typeof auth.signInWithCustomTicket === "function") {
      await auth.setCustomSignFunc(function () { return Promise.resolve(ticket); });
      await auth.signInWithCustomTicket();
      return;
    }
    if (auth && typeof auth.signInWithTicket === "function") {
      await auth.signInWithTicket(ticket);
      return;
    }
    throw new Error("当前 SDK 不支持自定义登录");
  }

  /* ---------- 密保常见问题（选择“自定义问题”时由用户填写） ---------- */
  var SECRET_QUESTIONS = [
    "你最喜欢的动漫作品是什么？",
    "你的出生城市是哪里？",
    "你小学的校名是什么？",
    "你的第一只宠物叫什么？",
    "你最尊敬的人是谁？",
    "自定义问题",
  ];

  /* ---------- 公开 API ---------- */

  /** 当前登录态：{ uid, isAnonymous, accountName } 或 null */
  function getState() {
    if (!_auth || !_auth.currentUser) return null;
    var u = _auth.currentUser;
    var uid = String(u.uid || u.sub || "");
    var isAnonymous = !/^D\d+$/.test(uid); // 业务 uid 形如 D100001
    return {
      uid: uid,
      isAnonymous: isAnonymous,
      accountName: isAnonymous ? "" : (localStorage.getItem(LS_NAME) || ""),
    };
  }

  /** 注册新账号并登录。migrate=true 时同步游客数据；secret={question,answer} 可选 */
  async function register(accountName, password, migrate, secret) {
    var guestData = migrate ? await loadGuestData() : null;
    var payload = { accountName: accountName, password: password, nickname: "" };
    if (secret) {
      payload.secretQuestion = secret.question;
      payload.secretAnswer = secret.answer;
    }
    var result = await callAuth("register", payload);
    await signInWithTicket(result.ticket);
    localStorage.setItem(LS_NAME, result.accountName);
    localStorage.setItem(LS_UID, result.uid);
    try { localStorage.setItem(LS_NICK, ""); } catch (e) {}
    if (migrate) await migrateData(guestData);
    return { uid: result.uid, accountName: result.accountName };
  }

  /** 已有账号登录（返回 { uid, accountName }），不迁移游客数据 */
  async function signIn(accountName, password) {
    var result = await callAuth("login", { accountName: accountName, password: password });
    await signInWithTicket(result.ticket);
    localStorage.setItem(LS_NAME, result.accountName);
    localStorage.setItem(LS_UID, result.uid);
    if (result.nickname) { try { localStorage.setItem(LS_NICK, result.nickname); } catch (e) {} }
    return { uid: result.uid, accountName: result.accountName };
  }

  /** 退出登录 */
  async function logout() {
    var auth = await getAuth();
    if (auth) {
      try { if (typeof auth.signOut === "function") await auth.signOut(); else if (typeof auth.logout === "function") await auth.logout(); } catch (e) {}
    }
    try { localStorage.removeItem(LS_NAME); } catch (e) {}
    try { localStorage.removeItem(LS_UID); } catch (e) {}
    location.reload();
  }

  /** 查询当前登录账号信息：{ accountName, nickname, hasSecret }（未登录返回 null） */
  async function getAccountInfo() {
    var st = getState();
    if (!st || st.isAnonymous) return null;
    var r = await callAuth("getAccountInfo", { uid: st.uid });
    return r.account;
  }

  /** 修改昵称 */
  async function updateNickname(nick) {
    var st = getState();
    if (!st || st.isAnonymous) throw new Error("请先登录");
    var r = await callAuth("setNickname", { uid: st.uid, nickname: nick.trim() });
    try { localStorage.setItem(LS_NICK, r.nickname || nick.trim()); } catch (e) {}
    return r;
  }

  /** 修改密码（需原密码） */
  async function changePassword(oldPwd, newPwd) {
    var st = getState();
    if (!st || st.isAnonymous) throw new Error("请先登录");
    return callAuth("changePassword", { accountName: st.accountName, oldPassword: oldPwd, newPassword: newPwd });
  }

  /** 查询账号的密保问题（忘记密码第一步） */
  async function getSecretQuestion(accountName) {
    return callAuth("getSecretQuestion", { accountName: accountName });
  }

  /** 设置/修改密保（已登录，需当前密码） */
  async function setSecret(question, answer, password) {
    var st = getState();
    if (!st || st.isAnonymous) throw new Error("请先登录");
    return callAuth("setSecret", { accountName: st.accountName, question: question, answer: answer, password: password });
  }

  /** 忘记密码：回答密保后重设密码 */
  async function resetPassword(accountName, question, answer, newPwd) {
    return callAuth("resetPassword", { accountName: accountName, question: question, answer: answer, newPassword: newPwd });
  }

  /* ---------- UI ---------- */

  var _open = false;
  var _mode = "login"; // login | register | forgot
  var _forgot = null;  // { step, accountName, question }
  var _accNick = "";
  var _accHasSecret = false;
  var _stylesInjected = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* 注入全部样式（幂等） */
  function ensureStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    var style = document.createElement("style");
    style.textContent = [
      /* 右下角浮动按钮/面板 */
      ".dpcca-auth-btn{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;border:1px solid #e6dcc8;background:#fdfaf4;color:#5c4a3d;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(92,74,61,.18);font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;transition:all .2s}",
      ".dpcca-auth-btn:hover{background:#efe7d9}",
      ".dpcca-auth-panel{position:fixed;right:18px;bottom:64px;z-index:1201;width:320px;max-width:calc(100vw - 36px);background:#fdfaf4;border:1px solid #e6dcc8;border-radius:14px;box-shadow:0 10px 30px rgba(92,74,61,.22);font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;color:#5c4a3d;overflow:hidden;display:none}",
      ".dpcca-auth-panel.show{display:block}",
      ".dpcca-auth-head{padding:14px 16px;border-bottom:1px solid #e6dcc8;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:space-between;background:#efe7d9}",
      ".dpcca-auth-close{cursor:pointer;color:#a8988a;font-size:16px;line-height:1}",
      ".dpcca-auth-body{padding:14px 16px;font-size:13px}",
      ".dpcca-auth-tip{color:#a8988a;font-size:12px;line-height:1.6;margin-bottom:12px}",
      ".dpcca-auth-inp{width:100%;padding:9px 11px;border:1px solid #e6dcc8;border-radius:8px;font-size:13px;color:#5c4a3d;background:#fffdf8;outline:none;margin-bottom:10px;box-sizing:border-box}",
      ".dpcca-auth-inp:focus{border-color:#c2ae8c}",
      ".dpcca-auth-btn2{width:100%;padding:9px 11px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:#d4c4a8;color:#4a3a2e;margin-bottom:6px;transition:all .2s}",
      ".dpcca-auth-btn2:hover{background:#c2ae8c}",
      ".dpcca-auth-btn2:disabled{opacity:.55;cursor:not-allowed}",
      ".dpcca-auth-link{color:#a8988a;font-size:12px;cursor:pointer;text-decoration:underline;margin-top:4px;display:inline-block}",
      ".dpcca-auth-ok{color:#7d8f69;font-size:12px;margin-top:6px;line-height:1.6}",
      ".dpcca-auth-err{color:#b06a5a;font-size:12px;margin-top:6px;line-height:1.6}",
      ".dpcca-auth-divider{display:flex;align-items:center;gap:8px;color:#c2ae8c;font-size:11px;margin:12px 0}",
      ".dpcca-auth-divider::before,.dpcca-auth-divider::after{content:'';flex:1;height:1px;background:#e6dcc8}",
      ".dpcca-auth-uid{display:inline-block;margin-left:4px;padding:1px 7px;border-radius:999px;background:#efe7d9;color:#8a7355;font-size:11px;font-weight:700;letter-spacing:.5px}",
      ".dpcca-auth-question{background:#efe7d9;border-radius:8px;padding:9px 11px;font-size:13px;font-weight:600;color:#4a3a2e;margin-bottom:10px}",
      ".dpcca-auth-foot{display:flex;justify-content:space-between;align-items:center;margin-top:2px}",
      /* 游客数据同步 / 确认弹窗 */
      ".dpcca-migrate-overlay{position:fixed;inset:0;z-index:1300;background:rgba(92,74,61,.4);display:flex;align-items:center;justify-content:center;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;padding:16px}",
      ".dpcca-migrate-box{width:min(360px,92vw);background:#fdfaf4;border:1px solid #e6dcc8;border-radius:14px;box-shadow:0 10px 30px rgba(92,74,61,.3);padding:18px;color:#5c4a3d}",
      ".dpcca-migrate-title{font-weight:700;font-size:15px;margin-bottom:8px;color:#4a3a2e}",
      ".dpcca-migrate-text{font-size:13px;color:#8a7355;line-height:1.7;margin-bottom:14px}",
      ".dpcca-migrate-btns{display:flex;flex-direction:column;gap:8px}",
      ".dpcca-migrate-btns button{padding:9px 11px;border-radius:8px;border:1px solid #e6dcc8;background:#fffdf8;color:#5c4a3d;font-size:13px;cursor:pointer;font-weight:600}",
      ".dpcca-migrate-btns button:hover{background:#efe7d9}",
      ".dpcca-migrate-btns .primary{background:#d4c4a8;color:#4a3a2e;border-color:#d4c4a8}",
      ".dpcca-migrate-btns .primary:hover{background:#c2ae8c}",
      /* 通用弹窗（修改密码 / 设置密保 / 编辑昵称） */
      ".dpcca-modal-overlay{position:fixed;inset:0;z-index:1300;background:rgba(92,74,61,.4);display:flex;align-items:center;justify-content:center;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;padding:16px}",
      ".dpcca-modal-box{width:min(360px,92vw);background:#fdfaf4;border:1px solid #e6dcc8;border-radius:14px;box-shadow:0 10px 30px rgba(92,74,61,.3);padding:18px;color:#5c4a3d}",
      ".dpcca-modal-title{font-weight:700;font-size:15px;margin-bottom:12px;color:#4a3a2e}",
      ".dpcca-modal-inp{width:100%;padding:9px 11px;border:1px solid #e6dcc8;border-radius:8px;font-size:13px;color:#5c4a3d;background:#fffdf8;outline:none;margin-bottom:10px;box-sizing:border-box}",
      ".dpcca-modal-inp:focus{border-color:#c2ae8c}",
      ".dpcca-modal-msg{font-size:12px;line-height:1.6;margin:4px 0 10px;min-height:16px}",
      ".dpcca-modal-msg.err{color:#b06a5a}.dpcca-modal-msg.ok{color:#7d8f69}",
      ".dpcca-modal-btns{display:flex;gap:8px;justify-content:flex-end}",
      ".dpcca-modal-btns button{padding:8px 14px;border-radius:8px;border:1px solid #e6dcc8;background:#fffdf8;color:#5c4a3d;font-size:13px;cursor:pointer;font-weight:600}",
      ".dpcca-modal-btns button:hover{background:#efe7d9}",
      ".dpcca-modal-btns .primary{background:#d4c4a8;color:#4a3a2e;border-color:#d4c4a8}",
      ".dpcca-modal-btns .primary:hover{background:#c2ae8c}",
      ".dpcca-modal-btns button:disabled{opacity:.55;cursor:not-allowed}",
      /* 个人账号卡片 */
      ".dpcca-acc{border:1px solid #e6dcc8;border-radius:14px;background:linear-gradient(180deg,#fdfaf4,#f6efe3);overflow:hidden;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;color:#5c4a3d}",
      ".dpcca-acc-head{padding:11px 16px;font-weight:700;font-size:14px;color:#4a3a2e;background:linear-gradient(135deg,#e7dcc8,#d9c9a8);display:flex;align-items:center;gap:8px}",
      ".dpcca-acc-body{padding:14px 16px;font-size:13px}",
      ".dpcca-acc-guest{text-align:center;padding:6px 4px}",
      ".dpcca-acc-guest-icon{font-size:40px;color:#c9b893;margin-bottom:8px}",
      ".dpcca-acc-guest-title{font-weight:700;font-size:15px;color:#4a3a2e;margin-bottom:6px}",
      ".dpcca-acc-guest-sub{color:#a8988a;font-size:12px;line-height:1.7;margin-bottom:14px}",
      ".dpcca-acc-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}",
      ".dpcca-acc-btns .dpcca-acc-btn{flex:1 1 auto;min-width:120px}",
      ".dpcca-acc-btn{padding:8px 12px;border-radius:8px;border:1px solid #e6dcc8;background:#fffdf8;color:#5c4a3d;font-size:12px;cursor:pointer;font-weight:600;transition:all .2s;font-family:inherit}",
      ".dpcca-acc-btn:hover{background:#efe7d9}",
      ".dpcca-acc-btn.primary{background:#d4c4a8;color:#4a3a2e;border-color:#d4c4a8}",
      ".dpcca-acc-btn.primary:hover{background:#c2ae8c}",
      ".dpcca-acc-btn.danger{color:#b06a5a;border-color:#e8cfc4;background:#fdf6f2}",
      ".dpcca-acc-btn.danger:hover{background:#f7e6de}",
      ".dpcca-acc-row{display:flex;align-items:center;justify-content:space-between;padding:7px 2px;border-bottom:1px dashed #e9e0d0}",
      ".dpcca-acc-row:last-of-type{border-bottom:none}",
      ".dpcca-acc-row .l{color:#a8988a;font-size:12px;flex:none;width:44px}",
      ".dpcca-acc-row .v{font-weight:600;color:#4a3a2e;word-break:break-all;text-align:right}",
      ".dpcca-acc-uid{display:inline-block;padding:1px 7px;border-radius:999px;background:#efe7d9;color:#8a7355;font-size:11px;font-weight:700;letter-spacing:.5px}",
      ".dpcca-acc-edit{color:#c2ae8c;cursor:pointer;margin-left:6px;font-size:12px}",
      ".dpcca-acc-edit:hover{color:#a08a5e}",
      ".dpcca-acc-warn{color:#c98a4b;font-weight:600}",
      ".dpcca-acc-ok{color:#7d8f69;font-weight:600}",
      ".dpcca-acc-sec-note{font-size:11px;color:#a8988a;line-height:1.6;margin-top:10px}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function mountUI() {
    // 纯本地模式（USE_CLOUD=false）不挂载
    if (typeof dataProvider !== "undefined" && dataProvider.USE_CLOUD === false) return;

    ensureStyles();

    // 挂载按钮
    var btn = document.createElement("div");
    btn.className = "dpcca-auth-btn";
    btn.id = "dpccaAuthBtn";
    btn.innerHTML = '<i class="fa-solid fa-user" style="font-size:12px"></i><span id="dpccaAuthLabel">游客</span>';
    btn.onclick = function () { _open = !_open; var p = $("dpccaAuthPanel"); if (p) p.classList.toggle("show", _open); };
    document.body.appendChild(btn);

    // 挂载面板
    var panel = document.createElement("div");
    panel.className = "dpcca-auth-panel";
    panel.id = "dpccaAuthPanel";
    panel.innerHTML = [
      '<div class="dpcca-auth-head"><span id="dpccaAuthTitle">DPCCA 账号</span><span class="dpcca-auth-close" onclick="document.getElementById(\'dpccaAuthPanel\').classList.remove(\'show\')">&times;</span></div>',
      '<div class="dpcca-auth-body" id="dpccaAuthBody"></div>',
    ].join("");
    document.body.appendChild(panel);

    refreshUI();
    // 数据层初始化完成后（可能稍晚）再刷新一次登录态显示与账号卡片
    getAuth().then(function () {
      refreshUI();
      if ($("dpccaAccountPanel")) renderAccountCard("dpccaAccountPanel");
    }).catch(function () {});
  }

  /* 打开/关闭右下角面板（可选指定视图） */
  function openPanel(mode) {
    if (mode) { _mode = mode; _forgot = null; }
    _open = true;
    var panel = $("dpccaAuthPanel");
    if (panel) panel.classList.add("show");
    refreshUI();
  }
  function closePanel() {
    _open = false;
    var panel = $("dpccaAuthPanel");
    if (panel) panel.classList.remove("show");
  }

  function refreshUI() {
    var label = $("dpccaAuthLabel");
    var body = $("dpccaAuthBody");
    if (!label || !body) return;
    var st = getState();
    if (st && !st.isAnonymous) {
      var nick = "";
      try { nick = localStorage.getItem(LS_NICK) || ""; } catch (e) {}
      label.textContent = nick || st.accountName || st.uid;
      body.innerHTML = [
        '<div class="dpcca-auth-ok" style="margin-bottom:8px"><i class="fa-solid fa-circle-check"></i> 已登录账号：<b>' + esc(st.accountName || "账号") + '</b><span class="dpcca-auth-uid">' + esc(st.uid) + '</span></div>',
        '<div class="dpcca-auth-tip">追番数据已同步到云端，可在任意设备使用同一账号登录。昵称、密码与密保问题请在「我的追番」页的账号卡片中管理。</div>',
        '<button class="dpcca-auth-btn2" onclick="DpccaAuth.logout()"><i class="fa-solid fa-right-from-bracket"></i> 退出登录</button>',
      ].join("");
    } else {
      label.textContent = "游客";
      renderPanelBody(body);
    }
  }

  function renderPanelBody(body) {
    if (_mode === "forgot") { renderForgotForm(body); return; }
    var isLogin = _mode === "login";
    body.innerHTML = [
      '<div class="dpcca-auth-tip">' + (isLogin ? "使用账号密码登录，恢复云端追番数据。" : "当前为<b>游客模式</b>：追番数据保存在本机与云端匿名账户。注册后可在任意设备登录恢复，换机/清缓存也不丢失。") + '</div>',
      '<input class="dpcca-auth-inp" id="dpccaUser" type="text" placeholder="账号名（2-20位，中英文/数字/符号）" autocomplete="username" maxlength="20">',
      '<input class="dpcca-auth-inp" id="dpccaPwd" type="password" placeholder="密码（8-32位，字母/数字/符号任一即可）" autocomplete="' + (isLogin ? "current-password" : "new-password") + '">',
      isLogin ? '' : '<input class="dpcca-auth-inp" id="dpccaPwd2" type="password" placeholder="确认密码" autocomplete="new-password">',
      isLogin ? '' : (
        '<div class="dpcca-auth-divider"><span>密保问题（可选）</span></div>' +
        '<select class="dpcca-auth-inp" id="dpccaSecQ" onchange="DpccaAuth._onSecQChange()">' +
          SECRET_QUESTIONS.map(function (q, i) { return '<option value="' + i + '">' + q + '</option>'; }).join("") +
        '</select>' +
        '<input class="dpcca-auth-inp" id="dpccaSecCus" type="text" placeholder="自定义问题（选择「自定义问题」时填写）" style="display:none" maxlength="100">' +
        '<input class="dpcca-auth-inp" id="dpccaSecA" type="text" placeholder="密保答案（忘记密码时用于找回）" maxlength="100">'
      ),
      isLogin
        ? '<button class="dpcca-auth-btn2" id="dpccaLoginBtn" onclick="DpccaAuth._doLogin()"><i class="fa-solid fa-sign-in-alt"></i> 登录</button>'
        : '<button class="dpcca-auth-btn2" id="dpccaRegBtn" onclick="DpccaAuth._doRegister()"><i class="fa-solid fa-user-plus"></i> 注册并登录</button>',
      '<div class="dpcca-auth-foot">' +
        '<a class="dpcca-auth-link" style="margin-top:0" onclick="DpccaAuth._toggleMode()">' + (isLogin ? "没有账号？注册" : "已有账号？登录") + '</a>' +
        (isLogin ? '<a class="dpcca-auth-link" style="margin-top:0" onclick="DpccaAuth._toForgot()">忘记密码？</a>' : '') +
      '</div>',
      '<div id="dpccaAuthMsg" class="dpcca-auth-ok"></div>',
    ].join("");
    $("dpccaUser").addEventListener("keydown", function (e) { if (e.key === "Enter") { isLogin ? DpccaAuth._doLogin() : DpccaAuth._doRegister(); } });
    $("dpccaPwd").addEventListener("keydown", function (e) { if (e.key === "Enter") { isLogin ? DpccaAuth._doLogin() : DpccaAuth._doRegister(); } });
    var p2 = $("dpccaPwd2");
    if (p2) p2.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._doRegister(); });
  }

  function renderForgotForm(body) {
    var f = _forgot || { step: 1 };
    if (f.step !== 2) {
      body.innerHTML = [
        '<div class="dpcca-auth-tip">通过<b>密保问题</b>找回密码：输入账号名，回答注册时设置的密保问题后即可重设密码。若注册时未设置密保，将无法找回。</div>',
        '<input class="dpcca-auth-inp" id="dpccaFUser" type="text" placeholder="账号名" autocomplete="username" maxlength="20">',
        '<button class="dpcca-auth-btn2" id="dpccaForgotNextBtn" onclick="DpccaAuth._doForgotNext()">下一步</button>',
        '<a class="dpcca-auth-link" onclick="DpccaAuth._toggleMode()">返回登录</a>',
        '<div id="dpccaAuthMsg" class="dpcca-auth-ok"></div>',
      ].join("");
      var u = $("dpccaFUser");
      if (u) u.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._doForgotNext(); });
    } else {
      body.innerHTML = [
        '<div class="dpcca-auth-tip">账号 <b>' + esc(f.accountName) + '</b> 的密保问题：</div>',
        '<div class="dpcca-auth-question">' + esc(f.question) + '</div>',
        '<input class="dpcca-auth-inp" id="dpccaFSec" type="text" placeholder="密保答案" maxlength="100">',
        '<input class="dpcca-auth-inp" id="dpccaFNew" type="password" placeholder="新密码（8-32位，字母/数字/符号任一即可）" autocomplete="new-password">',
        '<input class="dpcca-auth-inp" id="dpccaFNew2" type="password" placeholder="确认新密码" autocomplete="new-password">',
        '<button class="dpcca-auth-btn2" id="dpccaForgotResetBtn" onclick="DpccaAuth._doForgotReset()">重置密码</button>',
        '<a class="dpcca-auth-link" onclick="DpccaAuth._toggleMode()">返回登录</a>',
        '<div id="dpccaAuthMsg" class="dpcca-auth-ok"></div>',
      ].join("");
      var s = $("dpccaFSec");
      if (s) s.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._doForgotReset(); });
    }
  }

  function _toggleMode() {
    _mode = _mode === "login" ? "register" : "login";
    _forgot = null;
    refreshUI();
  }

  function _toForgot() {
    _mode = "forgot";
    _forgot = { step: 1 };
    refreshUI();
  }

  function _onSecQChange() {
    var sel = $("dpccaSecQ");
    var cus = $("dpccaSecCus");
    if (!sel || !cus) return;
    var isCustom = parseInt(sel.value, 10) === SECRET_QUESTIONS.length - 1;
    cus.style.display = isCustom ? "" : "none";
    if (!isCustom) cus.value = "";
  }

  function msg(text, isErr) {
    var el = $("dpccaAuthMsg");
    if (!el) return;
    el.className = isErr ? "dpcca-auth-err" : "dpcca-auth-ok";
    el.textContent = text;
  }

  function setBtnDisabled(id, disabled, text) {
    var el = $(id);
    if (!el) return;
    // 首次调用时记住按钮原始内容，取消禁用时还原（避免失败后停留在“登录中…”）
    if (!el.getAttribute("data-orig")) el.setAttribute("data-orig", el.innerHTML);
    el.disabled = disabled;
    el.innerHTML = text || el.getAttribute("data-orig");
  }

  /* ---------- 通用弹窗 ---------- */
  function openModal(html) {
    closeModal();
    var ov = document.createElement("div");
    ov.className = "dpcca-modal-overlay";
    ov.id = "dpccaModal";
    ov.innerHTML = '<div class="dpcca-modal-box">' + html + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeModal(); });
  }
  function closeModal() {
    var ov = $("dpccaModal");
    if (ov) ov.remove();
  }
  function modalMsg(text, isErr) {
    var el = $("dpccaModalMsg");
    if (!el) return;
    el.className = "dpcca-modal-msg " + (isErr ? "err" : "ok");
    el.textContent = text;
  }

  /* ---------- 确认弹窗（复用样式）：resolve(true/false) ---------- */
  function confirmBox(title, text, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "dpcca-migrate-overlay";
      ov.innerHTML = [
        '<div class="dpcca-migrate-box">',
        '  <div class="dpcca-migrate-title">' + title + '</div>',
        '  <div class="dpcca-migrate-text">' + text + '</div>',
        '  <div class="dpcca-migrate-btns">',
        '    <button class="primary" data-v="1">' + okLabel + '</button>',
        '    <button data-v="0">' + cancelLabel + '</button>',
        '  </div>',
        '</div>',
      ].join("");
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-v]") : null;
        if (!btn) return;
        var v = btn.getAttribute("data-v");
        ov.remove();
        resolve(v === "1");
      });
    });
  }

  /* 注册确认弹窗：返回 true=同步游客数据 / false=不同步 / null=取消 */
  function confirmMigrate(count) {
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "dpcca-migrate-overlay";
      ov.innerHTML = [
        '<div class="dpcca-migrate-box">',
        '  <div class="dpcca-migrate-title">发现游客数据</div>',
        '  <div class="dpcca-migrate-text">当前游客模式保存了 <b>' + count + '</b> 部番剧的追番记录。注册后是否将其同步到新账号？</div>',
        '  <div class="dpcca-migrate-btns">',
        '    <button class="primary" data-v="1"><i class="fa-solid fa-cloud-arrow-up"></i> 同步游客数据</button>',
        '    <button data-v="0">不同步，从新档开始</button>',
        '    <button data-v="c">取消</button>',
        '  </div>',
        '</div>',
      ].join("");
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-v]") : null;
        if (!btn) return;
        var v = btn.getAttribute("data-v");
        var val = v === "1" ? true : (v === "0" ? false : null);
        ov.remove();
        resolve(val);
      });
    });
  }

  async function _doRegister() {
    var name = ($("dpccaUser") ? $("dpccaUser").value : "").trim();
    var pwd = $("dpccaPwd") ? $("dpccaPwd").value : "";
    var pwd2 = $("dpccaPwd2") ? $("dpccaPwd2").value : "";
    if (!validName(name)) { msg("账号名需 2-20 位，仅限中英文、数字与符号（. _ @ - 等，半角全角均可），且不能以符号开头或结尾", true); return; }
    if (!validPassword(pwd)) { msg("密码需 8-32 位，字母、数字、符号任含其一即可", true); return; }
    if (pwd !== pwd2) { msg("两次输入的密码不一致", true); return; }

    // 读取可选密保
    var secQ = "";
    var secA = ($("dpccaSecA") ? $("dpccaSecA").value : "").trim();
    var sel = $("dpccaSecQ");
    if (sel) {
      var qi = parseInt(sel.value, 10);
      if (qi === SECRET_QUESTIONS.length - 1) {
        secQ = ($("dpccaSecCus") ? $("dpccaSecCus").value : "").trim();
      } else if (qi >= 0 && qi < SECRET_QUESTIONS.length) {
        secQ = SECRET_QUESTIONS[qi];
      }
    }
    var secret = null;
    if (secQ || secA) {
      if (!secQ) { msg("已填写密保答案，请同时选择/填写密保问题", true); return; }
      if (!secA) { msg("已选择密保问题，请同时填写密保答案", true); return; }
      secret = { question: secQ, answer: secA };
    } else {
      // 未设置密保：弹窗提醒，坚持跳过则继续
      var keepGoing = await confirmBox(
        "未设置密保问题",
        "你尚未设置密保问题。<b>若日后忘记密码，将无法通过密保找回</b>（当前不支持邮箱等其他找回方式）。请务必牢记你的密码。<br><br>仍要继续注册吗？",
        "我记住了，继续注册",
        "返回设置密保"
      );
      if (!keepGoing) { msg("你可以在下方选择或填写密保问题与答案", true); return; }
    }

    // 检测当前是否有游客数据，有则弹窗让用户选择是否同步
    var hasGuest = false;
    var guestCount = 0;
    try {
      var gd = await loadGuestData();
      if (gd) { hasGuest = true; guestCount = Object.keys(gd).length; }
    } catch (e) {}
    var migrate = false;
    if (hasGuest) {
      var choice = await confirmMigrate(guestCount);
      if (choice === null) return; // 用户取消注册
      migrate = choice;
    }

    setBtnDisabled("dpccaRegBtn", true, "注册中…");
    try {
      var r = await register(name, pwd, migrate, secret);
      msg("注册成功，UID " + r.uid + (migrate ? "，游客数据已同步" : ""), false);
      toast("注册成功，UID " + r.uid, false);
      try {
        if (window.DpccaReviewWall && window.DpccaReviewWall.rebuildOnce) {
          await window.DpccaReviewWall.rebuildOnce(true, true);
        }
      } catch (e) { console.warn("评论墙初始重建跳过", e); }
      setTimeout(function () { location.reload(); }, 800);
    } catch (e) {
      msg(e.message || "注册失败", true);
    } finally {
      setBtnDisabled("dpccaRegBtn", false, "");
    }
  }

  async function _doLogin() {
    var name = ($("dpccaUser") ? $("dpccaUser").value : "").trim();
    var pwd = $("dpccaPwd") ? $("dpccaPwd").value : "";
    if (!name || !pwd) { msg("请输入账号名和密码", true); return; }
    setBtnDisabled("dpccaLoginBtn", true, "登录中…");
    try {
      var r = await signIn(name, pwd);
      msg("登录成功，UID " + r.uid, false);
      toast("登录成功", false);
      setTimeout(function () { location.reload(); }, 600);
    } catch (e) {
      msg(e.message || "登录失败", true);
    } finally {
      setBtnDisabled("dpccaLoginBtn", false, "");
    }
  }

  async function _doForgotNext() {
    var name = ($("dpccaFUser") ? $("dpccaFUser").value : "").trim();
    if (!name) { msg("请输入账号名", true); return; }
    setBtnDisabled("dpccaForgotNextBtn", true, "查询中…");
    try {
      var r = await getSecretQuestion(name);
      _forgot = { step: 2, accountName: name, question: r.question };
      refreshUI();
    } catch (e) {
      msg(e.message || "查询失败", true);
    } finally {
      setBtnDisabled("dpccaForgotNextBtn", false, "");
    }
  }

  async function _doForgotReset() {
    var ans = ($("dpccaFSec") ? $("dpccaFSec").value : "").trim();
    var p1 = $("dpccaFNew") ? $("dpccaFNew").value : "";
    var p2 = $("dpccaFNew2") ? $("dpccaFNew2").value : "";
    if (!ans) { msg("请输入密保答案", true); return; }
    if (!validPassword(p1)) { msg("新密码需 8-32 位，字母、数字、符号任含其一即可", true); return; }
    if (p1 !== p2) { msg("两次输入的新密码不一致", true); return; }
    setBtnDisabled("dpccaForgotResetBtn", true, "重置中…");
    try {
      await resetPassword(_forgot.accountName, _forgot.question, ans, p1);
      toast("密码已重置，请用新密码登录", false);
      _mode = "login";
      _forgot = null;
      refreshUI();
    } catch (e) {
      msg(e.message || "重置失败", true);
    } finally {
      setBtnDisabled("dpccaForgotResetBtn", false, "");
    }
  }

  /* ---------- 个人账号卡片 ---------- */

  async function renderAccountCard(elId) {
    var el = typeof elId === "string" ? $(elId) : elId;
    if (!el) return;
    ensureStyles();
    var st = getState();

    if (!st || st.isAnonymous) {
      el.innerHTML = [
        '<div class="dpcca-acc">',
        '  <div class="dpcca-acc-head"><i class="fa-solid fa-user-shield"></i> 个人账号</div>',
        '  <div class="dpcca-acc-body">',
        '    <div class="dpcca-acc-guest">',
        '      <div class="dpcca-acc-guest-icon"><i class="fa-solid fa-circle-user"></i></div>',
        '      <div class="dpcca-acc-guest-title">游客模式</div>',
        '      <div class="dpcca-acc-guest-sub">当前为<b>游客模式</b>，追番数据仅保存在本机与云端匿名账户，<b>未同步到个人账号</b>。注册账号后可自定义昵称、设置密保，并在任意设备同步数据。</div>',
        '      <div class="dpcca-acc-btns">',
        '        <button class="dpcca-acc-btn primary" onclick="DpccaAuth.openPanel(\'register\')"><i class="fa-solid fa-user-plus"></i> 注册账号</button>',
        '        <button class="dpcca-acc-btn" onclick="DpccaAuth.openPanel(\'login\')"><i class="fa-solid fa-sign-in-alt"></i> 登录已有账号</button>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</div>',
      ].join("");
      return;
    }

    // 已登录：先显示基础信息，再异步拉取昵称/密保状态
    var accName = st.accountName || "账号";
    var nick = "";
    try { nick = localStorage.getItem(LS_NICK) || ""; } catch (e) {}
    el.innerHTML = [
      '<div class="dpcca-acc">',
      '  <div class="dpcca-acc-head"><i class="fa-solid fa-user-check"></i> 个人账号</div>',
      '  <div class="dpcca-acc-body">',
      '    <div class="dpcca-acc-row"><span class="l">昵称</span><span class="v"><b id="dpccaNickVal">' + esc(nick || accName) + '</b></span></div>',
      '    <div class="dpcca-acc-row"><span class="l">账号</span><span class="v">' + esc(accName) + '</span></div>',
      '    <div class="dpcca-acc-row"><span class="l">UID</span><span class="v"><span class="dpcca-acc-uid">' + esc(st.uid) + '</span></span></div>',
      '    <div class="dpcca-acc-row"><span class="l">密保</span><span class="v" id="dpccaSecretVal">…</span></div>',
      '    <div class="dpcca-acc-btns">',
      '      <button class="dpcca-acc-btn" onclick="DpccaAuth._editNick()"><i class="fa-solid fa-pen"></i> 修改昵称</button>',
      '      <button class="dpcca-acc-btn" onclick="DpccaAuth._openChangePwd()"><i class="fa-solid fa-key"></i> 修改密码</button>',
      '      <button class="dpcca-acc-btn" id="dpccaSecBtn" onclick="DpccaAuth._openSecretModal()"><i class="fa-solid fa-shield-halved"></i> 设置密保</button>',
      '      <button class="dpcca-acc-btn danger" onclick="DpccaAuth.logout()"><i class="fa-solid fa-right-from-bracket"></i> 退出登录</button>',
      '    </div>',
      '    <div class="dpcca-acc-sec-note">密保问题用于忘记密码时找回账号；设置密保需要验证当前密码。</div>',
      '  </div>',
      '</div>',
    ].join("");

    var info = null;
    try { info = await getAccountInfo(); } catch (e) {}
    if (info) {
      _accNick = info.nickname || accName;
      _accHasSecret = !!info.hasSecret;
      try { if (info.nickname) localStorage.setItem(LS_NICK, info.nickname); } catch (e) {}
      var nv = $("dpccaNickVal");
      if (nv) nv.textContent = _accNick;
      var sv = $("dpccaSecretVal");
      if (sv) sv.innerHTML = _accHasSecret
        ? '<span class="dpcca-acc-ok"><i class="fa-solid fa-shield"></i> 已设置</span>'
        : '<span class="dpcca-acc-warn">未设置</span>';
      var sb = $("dpccaSecBtn");
      if (sb) sb.innerHTML = '<i class="fa-solid fa-shield-halved"></i> ' + (_accHasSecret ? "修改密保" : "设置密保");
    }
  }

  function refreshAccountCard() {
    if ($("dpccaAccountPanel")) renderAccountCard("dpccaAccountPanel");
  }

  /* 修改昵称弹窗 */
  function _editNick() {
    openModal(
      '<div class="dpcca-modal-title"><i class="fa-solid fa-pen"></i> 修改昵称</div>' +
      '<input class="dpcca-modal-inp" id="dpccaNickInput" type="text" placeholder="昵称（1-20字，中英文/数字/空格及 - _ · .）" maxlength="20" value="' + esc(_accNick || "") + '">' +
      '<div id="dpccaModalMsg" class="dpcca-modal-msg"></div>' +
      '<div class="dpcca-modal-btns">' +
      '  <button class="primary" id="dpccaNickSave" onclick="DpccaAuth._saveNick()">保存</button>' +
      '  <button onclick="DpccaAuth.closeModal()">取消</button>' +
      '</div>'
    );
    var inp = $("dpccaNickInput");
    if (inp) { inp.focus(); inp.select(); inp.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._saveNick(); }); }
  }

  async function _saveNick() {
    var v = $("dpccaNickInput") ? $("dpccaNickInput").value.trim() : "";
    if (!validNick(v)) { modalMsg("昵称需 1-20 位，仅限中英文、数字、空格及 - _ · .", true); return; }
    setBtnDisabled("dpccaNickSave", true, "保存中…");
    try {
      await updateNickname(v);
      _accNick = v;
      var nv = $("dpccaNickVal");
      if (nv) nv.textContent = v;
      toast("昵称已更新", false);
      closeModal();
      refreshUI();
    } catch (e) {
      modalMsg(e.message || "保存失败", true);
    } finally {
      setBtnDisabled("dpccaNickSave", false, "");
    }
  }

  /* 修改密码弹窗 */
  function _openChangePwd() {
    openModal(
      '<div class="dpcca-modal-title"><i class="fa-solid fa-key"></i> 修改密码</div>' +
      '<input class="dpcca-modal-inp" id="dpccaOldPwd" type="password" placeholder="原密码" autocomplete="current-password">' +
      '<input class="dpcca-modal-inp" id="dpccaNewPwd" type="password" placeholder="新密码（8-32位，字母/数字/符号任一即可）" autocomplete="new-password">' +
      '<input class="dpcca-modal-inp" id="dpccaNewPwd2" type="password" placeholder="确认新密码" autocomplete="new-password">' +
      '<div id="dpccaModalMsg" class="dpcca-modal-msg"></div>' +
      '<div class="dpcca-modal-btns">' +
      '  <button class="primary" id="dpccaPwdSave" onclick="DpccaAuth._saveChangePwd()">保存</button>' +
      '  <button onclick="DpccaAuth.closeModal()">取消</button>' +
      '</div>'
    );
    var o = $("dpccaOldPwd");
    if (o) { o.focus(); o.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._saveChangePwd(); }); }
  }

  async function _saveChangePwd() {
    var oldP = $("dpccaOldPwd") ? $("dpccaOldPwd").value : "";
    var newP = $("dpccaNewPwd") ? $("dpccaNewPwd").value : "";
    var newP2 = $("dpccaNewPwd2") ? $("dpccaNewPwd2").value : "";
    if (!oldP) { modalMsg("请输入原密码", true); return; }
    if (!validPassword(newP)) { modalMsg("新密码需 8-32 位，字母、数字、符号任含其一即可", true); return; }
    if (newP !== newP2) { modalMsg("两次输入的新密码不一致", true); return; }
    setBtnDisabled("dpccaPwdSave", true, "保存中…");
    try {
      await changePassword(oldP, newP);
      toast("密码修改成功", false);
      closeModal();
    } catch (e) {
      modalMsg(e.message || "修改失败", true);
    } finally {
      setBtnDisabled("dpccaPwdSave", false, "");
    }
  }

  /* 设置/修改密保弹窗 */
  function _openSecretModal() {
    openModal(
      '<div class="dpcca-modal-title"><i class="fa-solid fa-shield-halved"></i> ' + (_accHasSecret ? "修改密保问题" : "设置密保问题") + '</div>' +
      '<div class="dpcca-modal-msg" style="color:#a8988a;font-size:12px;line-height:1.6">密保问题用于忘记密码时找回账号，请选择容易记住、不易被他人猜到的问题。</div>' +
      '<input class="dpcca-modal-inp" id="dpccaSecPwd" type="password" placeholder="当前密码（用于验证身份）" autocomplete="current-password">' +
      '<select class="dpcca-modal-inp" id="dpccaSecQ" onchange="DpccaAuth._onSecQChange()">' +
        SECRET_QUESTIONS.map(function (q, i) { return '<option value="' + i + '">' + q + '</option>'; }).join("") +
      '</select>' +
      '<input class="dpcca-modal-inp" id="dpccaSecCus" type="text" placeholder="自定义问题（选择「自定义问题」时填写）" style="display:none" maxlength="100">' +
      '<input class="dpcca-modal-inp" id="dpccaSecA" type="text" placeholder="密保答案" maxlength="100">' +
      '<div id="dpccaModalMsg" class="dpcca-modal-msg"></div>' +
      '<div class="dpcca-modal-btns">' +
      '  <button class="primary" id="dpccaSecSave" onclick="DpccaAuth._saveSecret()">保存</button>' +
      '  <button onclick="DpccaAuth.closeModal()">取消</button>' +
      '</div>'
    );
    var p = $("dpccaSecPwd");
    if (p) { p.focus(); p.addEventListener("keydown", function (e) { if (e.key === "Enter") DpccaAuth._saveSecret(); }); }
  }

  async function _saveSecret() {
    var pwd = $("dpccaSecPwd") ? $("dpccaSecPwd").value : "";
    var sel = $("dpccaSecQ");
    var cus = $("dpccaSecCus");
    var ans = $("dpccaSecA") ? $("dpccaSecA").value.trim() : "";
    var q = "";
    if (sel) {
      var qi = parseInt(sel.value, 10);
      q = qi === SECRET_QUESTIONS.length - 1 ? (cus ? cus.value : "").trim() : SECRET_QUESTIONS[qi];
    }
    if (!pwd) { modalMsg("请输入当前密码", true); return; }
    if (q.length < 2) { modalMsg("请选择或填写密保问题（至少 2 字）", true); return; }
    if (!ans) { modalMsg("请填写密保答案", true); return; }
    setBtnDisabled("dpccaSecSave", true, "保存中…");
    try {
      await setSecret(q, ans, pwd);
      _accHasSecret = true;
      toast("密保已保存", false);
      closeModal();
      refreshAccountCard();
    } catch (e) {
      modalMsg(e.message || "保存失败", true);
    } finally {
      setBtnDisabled("dpccaSecSave", false, "");
    }
  }

  window.DpccaAuth = {
    getState: getState,
    register: register,
    signIn: signIn,
    logout: logout,
    getAccountInfo: getAccountInfo,
    updateNickname: updateNickname,
    changePassword: changePassword,
    getSecretQuestion: getSecretQuestion,
    setSecret: setSecret,
    resetPassword: resetPassword,
    renderAccountCard: renderAccountCard,
    openPanel: openPanel,
    closePanel: closePanel,
    openModal: openModal,
    closeModal: closeModal,
    _toggleMode: _toggleMode,
    _toForgot: _toForgot,
    _onSecQChange: _onSecQChange,
    _doRegister: _doRegister,
    _doLogin: _doLogin,
    _doForgotNext: _doForgotNext,
    _doForgotReset: _doForgotReset,
    _editNick: _editNick,
    _saveNick: _saveNick,
    _openChangePwd: _openChangePwd,
    _saveChangePwd: _saveChangePwd,
    _openSecretModal: _openSecretModal,
    _saveSecret: _saveSecret,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountUI);
  } else {
    mountUI();
  }
})();
