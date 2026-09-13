/* ============================================================
 * DPCCA 公告弹窗 v1（2026-09-12 新增功能）
 * ------------------------------------------------------------
 * 配置来源：云数据库 site_config 集合的单文档 doc("announcement")
 *   { enabled:Boolean, content:String, updatedAt, updatedBy }
 *   集合规则 read=true / write=false —— 前台只读，写入仅经云函数
 *   admin_login（action=configGet / configSave，管理后台「公告弹窗」）。
 *
 * 展示规则（与需求一致）：
 *   - enabled=true 且有内容时，用户「每次进入页面」都会弹出，
 *     不依赖登录态，游客与注册用户一视同仁；
 *   - 右上角 × 或点击遮罩：仅关闭本次，下次进入仍会弹出；
 *   - 底部「不再弹出」勾选后：本机持久化静默，之后不再弹出。
 *     静默记录绑定「公告内容指纹」——管理员改动公告内容后，此前
 *     勾选过「不再弹出」的用户会重新看到新公告，避免公告更新后
 *     老用户永远看不到（内容未变则保持静默）。
 *
 * 用法：页面引入 <script src="announcement.js?v=1"></script> 即自动挂载。
 *   管理后台可先设 window.DPCCA_ANNOUNCE_AUTO = false 禁止自动弹出，
 *   再调用 DpccaAnnouncement.preview(content) 做与线上一致的预览。
 * 依赖：window.cloudbase（SDK 2.32.0）、页面数据层 window.dataProvider。
 * ============================================================ */
(function () {
  if (window.DpccaAnnouncement) return; // 防止重复加载

  var CFG_COLL = "site_config";
  var CFG_DOC = "announcement";
  var LS_SKIP = "dpcca_announce_skip"; // 值 = 已静默公告的内容指纹

  var overlay = null;
  var els = {};
  var shownOnce = false;     // 同一页面会话内只自动弹一次
  var previewMode = false;

  /* ---------- 基础工具 ---------- */

  /* 取页面共享的云数据层实例（与 feedback.js 同源策略）：
   * 兼容全局词法变量 dataProvider 与 window.dataProvider 两种暴露方式 */
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

  /* 等待数据层云初始化完成（app/db 就绪），带 2s 超时兜底 */
  function cloudReady() {
    var cloud = getCloud();
    if (!cloud || typeof cloud._getDB !== "function") return Promise.resolve();
    if (cloud._db) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(finish, 2000);
      function finish() { if (!done) { done = true; clearTimeout(timer); resolve(); } }
      cloud._getDB().then(finish).catch(finish);
    });
  }

  function showMsg(msg, isErr) {
    if (typeof window.toast === "function") {
      try { window.toast(msg, !!isErr); return; } catch (e) {}
    }
  }

  /* 读云端公告配置：任何异常（集合未创建 / 无权限 / 离线）一律降级为「无公告」，不打扰用户 */
  function readConfig() {
    return cloudReady().then(function () {
      var cloud = getCloud();
      if (!cloud || typeof cloud._getDB !== "function") return null;
      return cloud._getDB().then(function (db) {
        return db.collection(CFG_COLL).doc(CFG_DOC).get();
      }).then(function (res) {
        var d = res && res.data;
        if (Array.isArray(d)) d = d[0] || null;
        if (!d || typeof d !== "object") return null;
        return { enabled: !!d.enabled, content: String(d.content == null ? "" : d.content) };
      });
    }).catch(function () { return null; });
  }

  /* 内容指纹：内容变化即指纹变化（用于「不再弹出」的失效判定） */
  function fingerprint(s) {
    var str = String(s == null ? "" : s);
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return str.length + "-" + h.toString(36);
  }

  function isSkipped(fp) {
    try { return localStorage.getItem(LS_SKIP) === fp; } catch (e) { return false; }
  }
  function markSkipped(fp) {
    try { localStorage.setItem(LS_SKIP, fp); } catch (e) {}
  }
  function clearSkipped() {
    try { localStorage.removeItem(LS_SKIP); } catch (e) {}
  }

  /* ---------- 样式 ---------- */

  function injectCSS() {
    if (document.getElementById("ancStyle")) return;
    var css = [
      /* 遮罩：覆盖页面内容，层级高于账号面板(1200/1300) */
      ".anc-overlay{position:fixed;inset:0;z-index:1600;background:rgba(60,45,35,.5);",
      "display:flex;align-items:center;justify-content:center;padding:18px;",
      "opacity:0;pointer-events:none;transition:opacity .22s ease;",
      "font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif}",
      ".anc-overlay.show{opacity:1;pointer-events:auto}",
      /* 面板 */
      ".anc-panel{position:relative;width:min(520px,100%);max-height:84vh;display:flex;flex-direction:column;",
      "background:#fdfaf4;border:1px solid #e6dcc8;border-radius:20px;",
      "box-shadow:0 18px 48px rgba(60,45,35,.32);overflow:hidden;",
      "transform:translateY(14px) scale(.985);transition:transform .22s ease}",
      ".anc-overlay.show .anc-panel{transform:translateY(0) scale(1)}",
      ".anc-panel::before{content:'';display:block;height:4px;flex:none;",
      "background:linear-gradient(90deg,#eeddb8,#dcbf8a,#b58d4f)}",
      /* 右上角关闭按钮（X）：圆形浅底 + 加深 hover，与底部勾选框明显区分 */
      ".anc-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border:none;border-radius:999px;",
      "background:#efe7d9;color:#8a7355;font-size:15px;line-height:1;cursor:pointer;",
      "display:flex;align-items:center;justify-content:center;transition:all .16s;z-index:2}",
      ".anc-close:hover{background:#d8cdb8;color:#5c4a3d;transform:scale(1.06)}",
      ".anc-close:focus-visible{outline:2px solid #b58d4f;outline-offset:2px}",
      /* 头部 */
      ".anc-head{display:flex;align-items:center;gap:12px;padding:20px 24px 12px;}",
      ".anc-badge{width:40px;height:40px;flex:none;border-radius:12px;display:flex;align-items:center;justify-content:center;",
      "background:linear-gradient(135deg,#dcbf8a,#b58d4f);color:#fff;font-size:17px;",
      "box-shadow:0 4px 12px rgba(181,141,79,.34)}",
      ".anc-title{font-size:18px;font-weight:800;color:#4a3a2e;letter-spacing:.02em}",
      ".anc-sub{font-size:11px;color:#a8988a;margin-top:2px}",
      /* 正文 */
      ".anc-body{padding:0 24px 6px;overflow-y:auto;flex:1;",
      "font-size:14px;line-height:1.9;color:#5c4a3d;white-space:pre-wrap;word-break:break-word}",
      /* 底部 */
      ".anc-foot{padding:14px 24px 18px;border-top:1px solid #f0e7d6;margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      /* 「不再弹出」：勾选框样式，弱化为次级操作 */
      ".anc-skip{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:6px 10px;border-radius:10px;transition:background .16s}",
      ".anc-skip:hover{background:#f6efe3}",
      ".anc-skip input{position:absolute;opacity:0;width:0;height:0}",
      ".anc-skip-box{width:17px;height:17px;flex:none;border:1.5px solid #cbb89a;border-radius:5px;background:#fffdf8;",
      "display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;transition:all .16s}",
      ".anc-skip-box i{opacity:0;transition:opacity .12s}",
      ".anc-skip input:checked+.anc-skip-box{background:#7d8f69;border-color:#7d8f69}",
      ".anc-skip input:checked+.anc-skip-box i{opacity:1}",
      ".anc-skip input:focus-visible+.anc-skip-box{outline:2px solid #b58d4f;outline-offset:2px}",
      ".anc-skip-txt{font-size:13px;color:#7a6a52;font-weight:600}",
      ".anc-skip-txt em{font-style:normal;font-weight:400;font-size:11px;color:#a8988a}",
      "@media(max-width:479px){.anc-head{padding:18px 18px 10px}.anc-body{padding:0 18px 6px}.anc-foot{padding:12px 18px 16px}.anc-skip-txt em{display:none}}",
    ].join("");
    var st = document.createElement("style");
    st.id = "ancStyle";
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- DOM ---------- */

  function buildDOM() {
    if (document.getElementById("ancOverlay")) return;
    injectCSS();

    overlay = document.createElement("div");
    overlay.id = "ancOverlay";
    overlay.className = "anc-overlay";
    overlay.innerHTML =
      '<div class="anc-panel" role="dialog" aria-modal="true" aria-labelledby="ancTitle">' +
      '  <button type="button" class="anc-close" id="ancClose" aria-label="关闭公告" title="关闭（下次进入仍会显示）"><i class="fa-solid fa-xmark"></i></button>' +
      '  <div class="anc-head">' +
      '    <span class="anc-badge"><i class="fa-solid fa-bullhorn"></i></span>' +
      '    <div>' +
      '      <div class="anc-title" id="ancTitle">公告</div>' +
      '      <div class="anc-sub">DPCCA · 站点公告</div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="anc-body" id="ancBody"></div>' +
      '  <div class="anc-foot">' +
      '    <label class="anc-skip" id="ancSkipWrap" title="勾选后本机不再显示此公告">' +
      '      <input type="checkbox" id="ancSkip">' +
      '      <span class="anc-skip-box"><i class="fa-solid fa-check"></i></span>' +
      '      <span class="anc-skip-txt">不再弹出<em>（勾选即关闭，以后不再显示）</em></span>' +
      '    </label>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);

    els.close = document.getElementById("ancClose");
    els.body = document.getElementById("ancBody");
    els.skip = document.getElementById("ancSkip");
    els.skipWrap = document.getElementById("ancSkipWrap");

    els.close.addEventListener("click", function () { close(); });
    // 点击遮罩空白处 = 关闭本次（不影响下次进入弹出）
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    els.skip.addEventListener("change", function () {
      if (!els.skip.checked) return;
      if (current && current.fingerprint) {
        markSkipped(current.fingerprint);
        showMsg("已设置「不再弹出」，以后进入将不再显示该公告", false);
      }
      close(true);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay && overlay.classList.contains("show")) close();
    });
  }

  /* ---------- 展示 / 关闭 ---------- */

  var current = null; // { content, fingerprint }

  var _prevOverflow = null;

  function show(item) {
    buildDOM();
    current = item || null;
    overlay.querySelector(".anc-body").textContent = (current && current.content) || "";
    if (els.skip) els.skip.checked = false;
    if (els.skipWrap) els.skipWrap.style.display = previewMode ? "none" : "";
    // 锁定背景滚动，关闭时还原
    try { _prevOverflow = document.body.style.overflow; } catch (e) { _prevOverflow = null; }
    document.body.style.overflow = "hidden";
    // 触发进场过渡
    void overlay.offsetWidth;
    overlay.classList.add("show");
  }

  function close(keepSkipChange) {
    if (!overlay) return;
    overlay.classList.remove("show");
    try { document.body.style.overflow = _prevOverflow || ""; } catch (e) {}
    if (!keepSkipChange && els.skip) els.skip.checked = false;
  }

  /* ---------- 对外 API ---------- */

  /* 预览（管理后台用）：传内容直接展示，隐藏「不再弹出」，不影响本机静默记录 */
  function preview(content) {
    previewMode = true;
    show({ content: String(content == null ? "" : content), fingerprint: "" });
  }

  window.DpccaAnnouncement = {
    preview: preview,
    show: preview,                 // 别名：手动展示给定内容
    close: close,
    readConfig: readConfig,
    resetSkip: clearSkipped,       // 清除本机「不再弹出」记录
    reload: function () { shownOnce = false; autoInit(); },
    version: 1,
  };

  /* ---------- 自动初始化 ---------- */

  function autoInit() {
    if (window.DPCCA_ANNOUNCE_AUTO === false) return; // 管理后台等场景禁止自动弹出
    if (shownOnce) return;
    readConfig().then(function (cfg) {
      if (!cfg || !cfg.enabled) return;
      var content = String(cfg.content == null ? "" : cfg.content).trim();
      if (!content) return;
      var fp = fingerprint(content);
      if (isSkipped(fp)) return; // 用户已勾选「不再弹出」且内容未变
      shownOnce = true;
      previewMode = false;
      show({ content: content, fingerprint: fp });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})();
