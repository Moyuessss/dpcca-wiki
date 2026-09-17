/* ============================================================
 * DPCCA 意见与反馈（首页右下角悬浮入口 + 弹窗表单）
 * ------------------------------------------------------------
 * - 仅已注册 D 账号（uid 形如 D\d+）可提交：前端提示引导注册，
 *   后端 feedback_api 云函数再次强制校验，不信任任何前端参数。
 * - 反馈写入 feedback 集合（read=false/write=false，客户端不可
 *   直接读写），管理端在 admin.html → 用户反馈 处理。
 * - 类型：bug 问题反馈 / suggestion 功能建议 / content 内容勘误 / other 其他
 *   正文 10-500 字；番剧详情内「点此反馈」自动预填 content + 关联番剧。
 * ============================================================ */
(function () {
  if (window.Feedback) return; // 防止重复加载

  var UID_RE = /^D\d+$/;
  var TYPES = [
    { v: "bug", icon: "🐛", label: "问题反馈", hint: "打不开 / 报错 / 数据错乱" },
    { v: "suggestion", icon: "💡", label: "功能建议", hint: "想要的新功能或改进" },
    { v: "content", icon: "✏️", label: "内容勘误", hint: "某部番剧资料有误或缺失" },
    { v: "other", icon: "🗂️", label: "其他", hint: "想说点别的" }
  ];
  var C = {
    type: "",
    refId: "",
    refTitle: "",
    submitting: false,
    cooldownUntil: 0
  };

  var fab, modal, txt, count, errBox, submitBtn, regBox, refRow, refText;

  /* ---------- 基础工具 ---------- */

  /* 取页面共享的云数据层实例。
   * 兼容两种暴露方式：全局词法变量 dataProvider（index.html 内联脚本声明）
   * 与 window.dataProvider；两者都没有时返回 null。 */
  function getCloud() {
    try {
      if (typeof dataProvider !== "undefined" && dataProvider && dataProvider._cloud) {
        return dataProvider._cloud;
      }
    } catch (e) {}
    try {
      var dp = window.dataProvider;
      if (dp && dp._cloud) return dp._cloud;
    } catch (e) {}
    return null;
  }

  function getApp() {
    var cloud = getCloud();
    return cloud && cloud._app ? cloud._app : null;
  }

  /* 取与页面共享的登录态：优先复用数据层 dataProvider._cloud._auth
   * （与 auth.js 右下角「游客/账号」按钮同源），避免因不同 auth 实例
   * 而出现“明明已登录、点反馈却还要再次登录”；再兜底本地 D 账号记录。 */
  function getAuthUser() {
    try {
      var cloud = getCloud();
      if (cloud && cloud._auth && cloud._auth.currentUser) return cloud._auth.currentUser;
    } catch (e) {}
    try {
      if (window.DpccaAuth && typeof window.DpccaAuth.getState === "function") {
        var st = window.DpccaAuth.getState();
        if (st && st.uid) return { uid: st.uid };
      }
    } catch (e) {}
    return null;
  }

  function getUid() {
    try {
      var u = getAuthUser();
      if (u && u.uid) return String(u.uid);
    } catch (e) {}
    // 兜底：云登录态尚未就绪时，本机已记录登录过的 D 账号也算已登录
    try {
      var ls = localStorage.getItem("dpcca_account_uid");
      if (ls && UID_RE.test(ls)) return ls;
    } catch (e) {}
    return "";
  }

  function isRegistered() {
    return UID_RE.test(getUid());
  }

  /* 等待数据层云初始化完成（app 就绪）后再刷新登录判定 / 提交反馈 */
  function cloudReady() {
    var cloud = getCloud();
    if (!cloud) return Promise.resolve();
    if (cloud._app && cloud._auth) return Promise.resolve(); // app/auth 均就绪
    if (typeof cloud._getDB !== "function") return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(finish, 2000);
      function finish() { if (!done) { done = true; clearTimeout(timer); resolve(); } }
      cloud._getDB().then(finish).catch(finish);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showMsg(msg, isErr) {
    if (typeof window.toast === "function") {
      window.toast(msg, !!isErr);
    } else {
      if (isErr) window.alert(msg);
    }
  }

  function callFeedback(data) {
    // 先等云数据层就绪（兼容页面加载初期 app 尚未初始化完成的情况）
    return cloudReady().then(function () {
      var app = getApp();
      if (!app || typeof app.callFunction !== "function") {
        return Promise.reject({ message: "数据服务未就绪，请稍后重试" });
      }
      return app.callFunction({ name: "feedback_api", data: data })
        .then(function (r) { return (r && r.result) || {}; });
    });
  }

  /* ---------- 样式 ---------- */

  function injectCSS() {
    if (document.getElementById("fbxStyle")) return;
    var css =
      "#fbxFab{position:fixed;right:20px;bottom:22px;z-index:90;display:flex;align-items:center;gap:8px;" +
      "height:48px;padding:0 8px 0 6px;border-radius:999px;border:1px solid #e2d5bd;background:#fdfaf4;" +
      "color:#6b4f2a;box-shadow:0 6px 18px rgba(107,79,42,.18);cursor:pointer;font-size:13px;font-weight:700;transition:all .2s}" +
      "#fbxFab:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(107,79,42,.26)}" +
      "#fbxFab .ic{width:36px;height:36px;border-radius:999px;display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(135deg,#dcbf8a,#b58d4f);color:#fff;font-size:15px;box-shadow:0 2px 6px rgba(181,141,79,.4)}" +
      "#fbxFab .lbl{letter-spacing:.02em}" +
      "@media(max-width:479px){#fbxFab{width:48px;padding:0;justify-content:center}#fbxFab .lbl{display:none}}" +
      ".fbx-panel{width:min(430px,calc(100vw - 36px));max-height:86vh;overflow:auto;border-radius:20px;padding:22px;position:relative}" +
      ".fbx-title{font-size:18px;font-weight:800;color:#4a3a2e;letter-spacing:.02em}" +
      ".fbx-sub{font-size:12px;color:#8a7a66;margin-top:4px;line-height:1.6}" +
      ".fbx-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border:none;border-radius:999px;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;font-size:14px;color:#a08e76;background:transparent;transition:all .15s}" +
      ".fbx-close:hover{background:var(--primary-soft,#efe7d9);color:#6b4f2a}" +
      ".fbx-sec{font-size:13px;font-weight:800;color:#4a3a2e;margin:16px 0 8px}" +
      ".fbx-types{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
      ".fbx-chip{border:1px solid #e2d5bd;background:#fdfaf4;color:#7a6a52;border-radius:12px;padding:9px 12px;cursor:pointer;" +
      "display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;transition:all .15s}" +
      ".fbx-chip:hover{border-color:#c9a96b}" +
      ".fbx-chip .hd{font-weight:700;color:#4a3a2e;font-size:13px;display:flex;align-items:center;gap:6px}" +
      ".fbx-chip .hk{font-size:11px;color:#a08e76}" +
      ".fbx-chip.on{border-color:#c9a96b;background:#f6eeda;box-shadow:inset 0 0 0 1px #c9a96b}" +
      ".fbx-reg{border:1px dashed #e0cba0;background:#fbf6ea;border-radius:12px;padding:10px 12px;font-size:12px;color:#7a6a52;margin-top:14px;line-height:1.7}" +
      ".fbx-reg b{color:#a8732f}" +
      ".fbx-ref{display:flex;align-items:center;gap:8px;border:1px solid #f0e3c8;background:#fbf6ea;border-radius:12px;" +
      "padding:8px 12px;font-size:12px;color:#7a6a52;margin-top:14px}" +
      ".fbx-ref .fa-circle-info{color:#a8732f}" +
      ".fbx-ref button{margin-left:auto;border:none;background:none;cursor:pointer;color:#a08e76;font-size:14px;padding:2px 4px}" +
      ".fbx-ref button:hover{color:#d9534f}" +
      "#fbxTxt{width:100%;border:1px solid #e2d5bd;background:#fffdf7;border-radius:12px;padding:10px 12px;font-size:13px;color:#4a3a2e;" +
      "outline:none;resize:vertical;min-height:104px;line-height:1.7;font-family:inherit}" +
      "#fbxTxt:focus{border-color:#c9a96b;box-shadow:0 0 0 3px rgba(201,169,107,.16)}" +
      "#fbxTxt::placeholder{color:#b7a98f}" +
      ".fbx-foot{display:flex;align-items:center;gap:10px;margin-top:10px}" +
      ".fbx-count{font-size:11px;color:#a08e76;flex:1}" +
      "#fbxSubmit{font-weight:700}" +
      "#fbxSubmit:disabled{opacity:.55;cursor:not-allowed}" +
      ".fbx-err{display:none;font-size:12px;color:#d9534f;margin-top:8px;line-height:1.6}" +
      ".fbx-err.show{display:block}" +
      ".fbx-ok{display:none;font-size:13px;color:#3f8f5f;font-weight:700;margin-top:8px}" +
      ".fbx-ok.show{display:block}";
    var st = document.createElement("style");
    st.id = "fbxStyle";
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 悬浮钮避让：与右下角「游客/账号」按钮并排，不重叠 ---------- */

  function layoutFab() {
    if (!fab) return;
    var right = 20;
    var bottom = 22;
    var btn = document.getElementById("dpccaAuthBtn");
    if (btn) {
      try {
        var r = btn.getBoundingClientRect();
        if (r && r.width > 0 && r.left > 0) {
          var gap = 10; // 与账号按钮的间距
          // FAB 右缘贴住账号按钮左缘：right = 账号按钮左缘距视口右边距离 + gap
          var tryRight = window.innerWidth - r.left + gap;
          if (tryRight + fab.offsetWidth + 12 <= window.innerWidth) {
            right = tryRight; // 水平并排：账号按钮在右，FAB 在左
          } else {
            bottom = window.innerHeight - r.top + gap; // 空间不足时挪到账号按钮正上方
          }
        }
      } catch (e) {}
    }
    fab.style.right = right + "px";
    fab.style.bottom = bottom + "px";
  }

  /* ---------- DOM ---------- */

  function buildDOM() {
    if (document.getElementById("fbxModal")) return;

    fab = document.createElement("button");
    fab.id = "fbxFab";
    fab.type = "button";
    fab.title = "意见与反馈（需要 D 账号）";
    fab.innerHTML = '<span class="ic"><i class="fa-solid fa-comment-dots"></i></span><span class="lbl">反馈</span>';
    fab.addEventListener("click", function () { Feedback.open(); });

    modal = document.createElement("div");
    modal.id = "fbxModal";
    modal.className = "modal-overlay";
    modal.innerHTML =
      '<div class="glass fbx-panel">' +
      '<button type="button" class="fbx-close" id="fbxClose" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="fbx-title"><i class="fa-regular fa-message mr-2" style="color:#a8732f"></i>意见与反馈</div>' +
      '<div class="fbx-sub" id="fbxSub">资料问题、Bug、功能建议……都可以告诉我们。<b style="color:#a8732f">每条反馈都需要登录 D 账号</b>，方便我们跟进并通知你处理结果。</div>' +
      '<div class="fbx-reg" id="fbxReg" style="display:none">' +
      '你还没有登录 D 账号。注册后即可提交反馈（注册即得专属 D 编号，还可同步追番数据）：' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
      '<button type="button" class="btn btn-primary" style="flex:1;font-size:12px" onclick="Feedback.needAuth(\'register\')"><i class="fa-solid fa-user-plus"></i> 注册 D 账号</button>' +
      '<button type="button" class="btn btn-ghost" style="flex:1;font-size:12px" onclick="Feedback.needAuth(\'login\')"><i class="fa-solid fa-sign-in-alt"></i> 已有账号登录</button>' +
      '</div></div>' +
      '<div class="fbx-ref" id="fbxRef" style="display:none">' +
      '<i class="fa-solid fa-circle-info"></i><span id="fbxRefText" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
      '<button type="button" id="fbxRefClear" title="取消关联"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="fbx-sec">反馈类型 <span style="color:#d9534f">*</span></div>' +
      '<div class="fbx-types" id="fbxTypes"></div>' +
      '<div class="fbx-sec">具体说明 <span style="color:#d9534f">*</span><span style="font-weight:500;color:#a08e76;font-size:11px;margin-left:6px">尽量描述：哪里有问题 / 想怎么改进 / 影响范围</span></div>' +
      '<textarea id="fbxTxt" maxlength="500" placeholder="例：某部番剧的放送日期有误；页面在 XX 操作下报错；希望支持按 XX 排序……"></textarea>' +
      '<div class="fbx-foot"><span class="fbx-count" id="fbxCount">0 / 500</span>' +
      '<button type="button" class="btn btn-primary" id="fbxSubmit" style="min-width:110px"><i class="fa-solid fa-paper-plane"></i> 提交反馈</button></div>' +
      '<div class="fbx-err" id="fbxErr"></div>' +
      '<div class="fbx-ok" id="fbxOk"><i class="fa-solid fa-circle-check"></i> 已收到，谢谢反馈！</div>' +
      '</div>';

    document.body.appendChild(fab);
    document.body.appendChild(modal);

    txt = document.getElementById("fbxTxt");
    count = document.getElementById("fbxCount");
    errBox = document.getElementById("fbxErr");
    submitBtn = document.getElementById("fbxSubmit");
    regBox = document.getElementById("fbxReg");
    refRow = document.getElementById("fbxRef");
    refText = document.getElementById("fbxRefText");

    var typesBox = document.getElementById("fbxTypes");
    TYPES.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "fbx-chip";
      b.dataset.v = t.v;
      b.innerHTML = '<span class="hd"><span>' + t.icon + "</span>" + t.label + "</span>" +
        '<span class="hk">' + t.hint + "</span>";
      b.addEventListener("click", function () { setType(t.v); });
      typesBox.appendChild(b);
    });

    document.getElementById("fbxClose").addEventListener("click", close);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close();
    });
    txt.addEventListener("input", function () {
      var n = txt.value.length;
      count.textContent = n + " / 500";
      if (n >= 490) count.style.color = "#d9534f"; else count.style.color = "";
      errBox.classList.remove("show");
    });
    document.getElementById("fbxRefClear").addEventListener("click", clearRef);
    submitBtn.addEventListener("click", submit);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.classList.contains("show")) close();
    });

    // 初始布局 + 窗口尺寸变化时避让账号按钮
    layoutFab();
    window.addEventListener("resize", function () { layoutFab(); });
    // 账号按钮文字变化（如登录态恢复）可能改变其宽度，动态重排避让
    var authLabel = document.getElementById("dpccaAuthLabel");
    if (authLabel && typeof MutationObserver !== "undefined") {
      try {
        new MutationObserver(function () { layoutFab(); })
          .observe(authLabel, { childList: true, characterData: true, subtree: true });
      } catch (e) {}
    }
  }

  /* ---------- 弹窗状态 ---------- */

  function refreshRegHint() {
    var reg = isRegistered();
    if (regBox) regBox.style.display = reg ? "none" : "";
    if (fab) {
      fab.title = reg ? "意见与反馈" : "意见与反馈（登录 D 账号后可提交）";
    }
    // 副标题随登录态变化：已登录无需再强调“需要登录”
    var sub = document.getElementById("fbxSub");
    if (sub) {
      sub.innerHTML = reg
        ? "资料问题、Bug、功能建议……都可以告诉我们，提交后我们会在后台及时处理。"
        : "资料问题、Bug、功能建议……都可以告诉我们。<b style=\"color:#a8732f\">每条反馈都需要登录 D 账号</b>，方便我们跟进并通知你处理结果。";
    }
  }

  function setType(v) {
    C.type = v;
    var chips = modal.querySelectorAll(".fbx-chip");
    chips.forEach(function (b) {
      b.classList.toggle("on", b.dataset.v === v);
    });
  }

  function clearRef() {
    C.refId = "";
    C.refTitle = "";
    refRow.style.display = "none";
    refText.textContent = "";
  }

  function setRef(id, title) {
    C.refId = id || "";
    C.refTitle = title || "";
    refText.textContent = "正在反馈《" + (title || id) + "》的资料问题";
    refRow.style.display = "";
  }

  function cooldownLabel() {
    var left = Math.ceil((C.cooldownUntil - Date.now()) / 1000);
    return left > 0 ? left + "s" : "";
  }

  function refreshSubmitState() {
    var left = cooldownLabel();
    submitBtn.disabled = C.submitting || !!left;
    submitBtn.innerHTML = C.submitting
      ? '<i class="fa-solid fa-spinner fa-spin"></i> 提交中…'
      : left
        ? "<i class=\"fa-solid fa-hourglass-half\"></i> " + left + " 后可再提交"
        : '<i class="fa-solid fa-paper-plane"></i> 提交反馈';
  }

  function setErr(msg) {
    errBox.textContent = msg || "";
    errBox.classList.toggle("show", !!msg);
  }

  function open(opts) {
    opts = opts || {};
    layoutFab(); // 打开前先避让右下角账号按钮
    C.submitting = false;
    setErr("");
    document.getElementById("fbxOk").classList.remove("show");
    refreshRegHint();
    refreshSubmitState();

    if (opts.type) setType(opts.type); else setType("");
    txt.value = "";
    count.textContent = "0 / 500";
    count.style.color = "";
    clearRef();
    if (opts.refId || opts.refTitle) setRef(opts.refId, opts.refTitle);

    modal.classList.add("show");
    setTimeout(function () { if (txt) txt.focus(); }, 260);
    // 数据层就绪后，以与页面登录按钮一致的登录态再刷新一次检测与按钮文案
    cloudReady().then(function () {
      if (modal && modal.classList.contains("show")) {
        refreshRegHint();
        refreshSubmitState();
      }
    });
  }

  function close() {
    modal.classList.remove("show");
    setErr("");
    C.submitting = false;
    refreshSubmitState();
  }

  /* ---------- 提交 ---------- */

  function submit() {
    if (submitBtn.disabled || C.submitting) return;
    var type = C.type;
    var content = txt.value.trim();

    if (!type) { setErr("请先选择反馈类型"); return; }
    if (content.length < 10) { setErr("反馈内容请至少写 10 个字"); txt.focus(); return; }
    if (content.length > 500) { setErr("反馈内容最多 500 个字"); txt.focus(); return; }

    if (!isRegistered()) {
      setErr("请先注册 / 登录 D 账号后再提交反馈（点击上方按钮即可）");
      return;
    }

    C.submitting = true;
    refreshSubmitState();

    callFeedback({
      action: "submit",
      data: {
        type: type,
        content: content,
        page: location.pathname + location.search,
        refId: C.refId,
        refTitle: C.refTitle
      }
    }).then(function (res) {
      C.submitting = false;
      if (res && res.ok) {
        C.cooldownUntil = Date.now() + 60 * 1000;
        refreshSubmitState();
        close();
        showMsg("反馈已提交，我们会认真查看，谢谢！");
      } else if (res && res.code === "NEED_ACCOUNT") {
        refreshRegHint();
        setErr(res.message || "请先注册 / 登录 D 账号后再提交反馈");
      } else {
        refreshSubmitState();
        setErr((res && res.message) || "提交失败，请稍后重试");
      }
    }).catch(function (e) {
      C.submitting = false;
      refreshSubmitState();
      setErr((e && e.message) || "提交失败，请检查网络后重试");
    });
  }

  /* ---------- 对外 ---------- */

  function needAuth(mode) {
    if (typeof window.DpccaAuth === "object" && window.DpccaAuth) {
      try {
        window.DpccaAuth.openPanel(mode === "login" ? "login" : "register");
        return;
      } catch (e) { /* ignore */ }
    }
    setErr("请先在页面右上角注册 / 登录 D 账号");
  }

  window.Feedback = {
    open: function (opts) { buildDOM(); open(opts || {}); },
    close: function () { if (modal) close(); },
    openForAnime: function (id) {
      buildDOM();
      var title = "";
      var el = document.getElementById("dpccaDetailTitle");
      if (el) title = (el.textContent || "").trim();
      open({ type: "content", refId: String(id || ""), refTitle: title });
    },
    needAuth: needAuth,
    isRegistered: isRegistered,
    version: 2
  };

  function init() {
    injectCSS();
    buildDOM();
    refreshRegHint();
    // 云登录态异步恢复后（游客自动登录 / D 账号会话恢复）再刷新一次提示
    cloudReady().then(refreshRegHint);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
