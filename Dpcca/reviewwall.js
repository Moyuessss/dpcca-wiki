/* ============================================================
 * reviewwall.js - DPCCA 公开评分/评论墙（前端库）
 * ------------------------------------------------------------
 * 供 index.html / profile.html 复用：
 *   1) 评分/评论提交后三端同步：个人档案 / 公开墙 / 管理后台（仅注册 D 账号）
 *   2) 番剧详情弹窗内"查看评分与评论"悬浮窗
 *      （平均分 + 各追番人评分与短评，全部同步展示）
 *   3) 删除整部追番记录时清空本人行；登录后自动补齐缺失的墙行
 * 依赖：cloudbase.full.js + auth.js + dataProvider 全局对象
 * 集合：anime_reviews（客户端只读 read=true，写入走云函数 reviews_api）
 * ============================================================ */
(function () {
  if (window.DpccaReviewWall) return;

  var REVIEW_COLL = "anime_reviews";
  var TYPE_LABEL = { open: "开播前预期评分", final: "完结评分", ep: "单集评分" };

  /* ---------- 基础访问 ---------- */
  function getApp() {
    try {
      if (typeof dataProvider !== "undefined" && dataProvider._cloud) return dataProvider._cloud._app;
    } catch (e) { /* ignore */ }
    return null;
  }
  function getDB() {
    var app = getApp();
    return app ? app.database() : null;
  }
  function getUid() {
    try {
      var app = getApp();
      if (!app) return "";
      var u = app.auth().currentUser;
      return (u && u.uid) || "";
    } catch (e) { return ""; }
  }
  function isRegistered() { return /^D\d+$/.test(getUid()); }

  function callReviews(data) {
    var app = getApp();
    if (!app) return Promise.resolve({ ok: false, code: "NO_APP" });
    return app
      .callFunction({ name: "reviews_api", data: data })
      .then(function (r) { return (r && r.result) || { ok: false }; })
      .catch(function (e) {
        console.warn("[reviewwall] reviews_api 调用失败", e);
        return { ok: false, code: "ERR", message: String((e && e.message) || e) };
      });
  }

  function alertError(res) {
    if (!res || res.ok) return;
    if (res.code === "NEED_ACCOUNT") {
      alert("评论墙提交失败：" + (res.message || "请先登录 D 账号"));
    } else if (res.message) {
      alert("评论墙提交失败：" + res.message);
    }
  }

  /* ---------- 三端同步（个人档案 / 公开墙 / 管理后台） ---------- */
  /** 提交某维度评分+短评：新建/更新对应墙行；score=0 且短评为空时删除该墙行。游客/未登录时静默跳过，不阻塞本地保存。 */
  function pushRating(animeId, title, type, ep, score, comment) {
    if (!isRegistered()) {
      console.log("[reviewwall] 游客身份，跳过公开墙提交");
      return Promise.resolve(null);
    }
    var data = {
      animeId: String(animeId || "").trim(),
      title: String(title || ""),
      type: type === "ep" ? "ep" : (type === "final" ? "final" : "open"),
      ep: String(ep == null || ep === "" ? "0" : ep),
      score: Number(score) || 0,
      comment: String(comment || "").trim().slice(0, 200),
    };
    if (!data.animeId) return Promise.resolve(null);
    return callReviews({ action: "upsert", data: data }).then(function (res) {
      console.log("[reviewwall] upsert 结果", res);
      if (!res || !res.ok) {
        alertError(res);
        // 失败兜底：稍后执行一次全量镜像 self-heal（幂等），保证三端最终一致
        if (res && res.code !== "NEED_ACCOUNT" && isRegistered()) retryRebuildSoon();
      }
      return res;
    });
  }

  var _rwRetryTimer = null;
  /** 实时同步失败后的兜底：延迟触发一次 rebuild 全量镜像（幂等、单飞） */
  function retryRebuildSoon() {
    if (_rwRetryTimer) return;
    _rwRetryTimer = setTimeout(function () {
      _rwRetryTimer = null;
      callReviews({ action: "rebuild" }).catch(function () { /* 忽略 */ });
    }, 5000);
  }

  /** 删除整部番剧记录后，一并移除本人该番剧全部墙行（公开墙/管理后台同步删除） */
  function clearAnime(animeId) {
    if (!isRegistered() || !animeId) return Promise.resolve(null);
    return callReviews({ action: "clearAnime", data: { animeId: String(animeId) } }).then(function (res) {
      alertError(res);
      return res;
    }).catch(function () { return null; });
  }

  /** 注册迁移后 / 登录后 / 页面进入时，按本人 user_anime 全量镜像 anime_reviews（补齐缺失行、
   *  更新不一致行、清理孤儿行，幂等，保留管理端 hidden 状态）。force=true 时忽略节流立即执行。 */
  function rebuildOnce(force, wait) {
    if (!isRegistered()) return wait ? Promise.resolve(null) : null;
    var uid = getUid();
    var KEY = "dpcca_rw_rebuild_" + uid;
    var last = 0;
    try { last = Number(localStorage.getItem(KEY)) || 0; } catch (e) { /* ignore */ }
    if (!force && Date.now() - last < 6 * 3600 * 1000) return wait ? Promise.resolve(null) : null;
    // 仅在重建成功后才记录节流时间；失败则清掉记录，下次进入页面可再次自动补同步
    var p = callReviews({ action: "rebuild" }).then(function (res) {
      try {
        if (res && res.ok) localStorage.setItem(KEY, String(Date.now()));
        else localStorage.removeItem(KEY);
      } catch (e) { /* ignore */ }
      return res;
    }).catch(function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      return null;
    });
    return wait ? p : null;
  }

  /* ---------- 读取评论墙 ---------- */
  /** 拉取某番剧全部正常评论行（open/final/各单集），供计数与弹窗使用 */
  function fetchRows(animeId) {
    var db = getDB();
    if (!db) return Promise.resolve([]);
    return db
      .collection(REVIEW_COLL)
      .where({ animeId: String(animeId || ""), status: "normal" })
      .limit(1000)
      .get()
      .then(function (r) { return (r && r.data) || []; })
      .catch(function () { return []; });
  }

  /** 刷新当前页面内某番剧全部 .rw-num 计数 */
  function refreshAll(animeId) {
    if (!animeId) return;
    fetchRows(animeId).then(function (rows) {
      var openN = 0, finalN = 0, epN = {};
      rows.forEach(function (r) {
        if (r.type === "open") openN++;
        else if (r.type === "final") finalN++;
        else if (r.type === "ep") epN[r.ep] = (epN[r.ep] || 0) + 1;
      });
      var numEls = document.querySelectorAll(".rw-num");
      for (var i = 0; i < numEls.length; i++) {
        var host = numEls[i].closest ? numEls[i].closest("[data-anime]") : null;
        if (!host || String(host.getAttribute("data-anime")) !== String(animeId)) continue;
        var type = host.getAttribute("data-type");
        if (type === "open") numEls[i].textContent = openN;
        else if (type === "final") numEls[i].textContent = finalN;
        else if (type === "ep") numEls[i].textContent = epN[host.getAttribute("data-ep")] || 0;
      }
    }).catch(function () { /* 静默 */ });
  }

  /* ---------- 悬浮窗 UI ---------- */
  function ensureCSS() {
    if (document.getElementById("rwStyle")) return;
    var css = document.createElement("style");
    css.id = "rwStyle";
    css.textContent = [
      "#rwMask{position:fixed;inset:0;background:rgba(10,12,18,.74);z-index:400;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;pointer-events:none;transition:opacity .2s ease}",
      "#rwMask.show{opacity:1;pointer-events:auto}",
      "#rwModal{width:min(92vw,560px);max-height:84vh;overflow:hidden;display:flex;flex-direction:column;background:linear-gradient(180deg,#1a2030,#141926);border:1px solid rgba(255,255,255,.09);border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.5);color:#e9e6df;font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif}",
      "#rwBody{overflow-y:auto;padding:18px;scrollbar-width:thin;scrollbar-color:#3d4866 transparent}",
      "#rwBody::-webkit-scrollbar{width:7px;height:7px}",
      "#rwBody::-webkit-scrollbar-thumb{background:#3d4866;border-radius:8px}",
      "#rwBody::-webkit-scrollbar-track{background:transparent}",
      ".rw-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07)}",
      ".rw-h .t{font-weight:700;font-size:15px}",
      ".rw-h .s{color:#8d97b5;font-size:12px;margin-top:2px;font-weight:400}",
      ".rw-x{background:rgba(255,255,255,.06);border:none;color:#aab;width:28px;height:28px;border-radius:9px;cursor:pointer;font-size:15px;flex:none}",
      ".rw-x:hover{background:rgba(255,255,255,.14)}",
      ".rw-avg{display:flex;align-items:center;gap:16px;padding:18px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.06)}",
      ".rw-avg .num{font-size:44px;font-weight:800;color:#e0b45f;line-height:1}",
      ".rw-avg .num small{font-size:15px;color:#8d97b5;font-weight:400}",
      ".rw-avg .meta{font-size:13px;color:#9aa3bd;line-height:1.7}",
      ".rw-avg .meta b{color:#e9e6df}",
      ".rw-empty{padding:44px 20px;text-align:center;color:#7d87a5;font-size:14px}",
      ".rw-empty .ico{font-size:34px;margin-bottom:10px;opacity:.8}",
      ".rw-item{display:flex;gap:12px;padding:13px 4px;border-bottom:1px dashed rgba(255,255,255,.06)}",
      ".rw-item .av{width:36px;height:36px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;background:linear-gradient(135deg,#6b7fae,#8a6a4f)}",
      ".rw-item .body{flex:1;min-width:0}",
      ".rw-item .who{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}",
      ".rw-item .who .nick{font-weight:600;color:#e6e3dc;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rw-item .who .me{font-size:10px;color:#c9a35c;border:1px solid rgba(201,163,92,.5);border-radius:6px;padding:0 5px}",
      ".rw-item .who .t{color:#5f6a86;font-size:11px;margin-left:auto}",
      ".rw-item .sc{font-size:13px;font-weight:700;color:#e0b45f}",
      ".rw-item .cm{font-size:13px;color:#c6c9d4;margin-top:4px;word-break:break-word}",
      ".rw-item.no{opacity:.55}",
      ".rw-load{text-align:center;color:#7d87a5;padding:40px 10px;font-size:13px}",
      ".rw-note{font-size:11px;color:#5f6a86;padding:10px 18px 12px}",
    ].join("");
    document.head.appendChild(css);
  }

  function ensureDom() {
    if (document.getElementById("rwMask")) return;
    var d = document.createElement("div");
    d.id = "rwMask";
    d.innerHTML = [
      '<div id="rwModal" role="dialog" aria-modal="true">',
      '  <div class="rw-h"><div><div class="t" id="rwTitle">评论墙</div><div class="s" id="rwSub"></div></div><button class="rw-x" id="rwClose" aria-label="关闭">✕</button></div>',
      '  <div id="rwBody"><div class="rw-load">加载中…</div></div>',
      '  <div class="rw-note" id="rwNote"></div>',
      "</div>",
    ].join("");
    document.body.appendChild(d);
    d.addEventListener("click", function (ev) {
      if (ev.target === d || ev.target.id === "rwClose") close();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") close();
    });
  }

  var _state = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function timeAgo(ts) {
    if (!ts) return "";
    var diff = Date.now() - ts;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 86400000 * 30) return Math.floor(diff / 86400000) + " 天前";
    var d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function halfStars(score) {
    var v = Math.round(Number(score || 0) * 2) / 2;
    var s = "";
    for (var i = 1; i <= 10; i++) {
      if (v >= i) s += "★";
      else if (v >= i - 0.5) s += "<span style='color:#e0b45f;opacity:.5'>★</span>";
      else s += "<span style='color:#3a4460'>★</span>";
    }
    return s;
  }

  function noteText(uid, epLabel) {
    if (!isRegistered()) return "提示：当前为游客身份，评分与短评仅保存在本机档案；注册 D 账号登录后会自动补同步到公开墙与管理后台。";
    return "三端同步：评分与短评会同时出现在「我的追番」档案、公开墙与管理后台；修改或删除评分时，三端同步更新。";
  }

  function render() {
    var st = _state;
    if (!st) return;
    var body = document.getElementById("rwBody");
    var titleEl = document.getElementById("rwTitle");
    var subEl = document.getElementById("rwSub");
    var noteEl = document.getElementById("rwNote");

    var dim = TYPE_LABEL[st.type] || "评分";
    titleEl.textContent = st.title || "评论墙";
    subEl.textContent = (st.type === "ep" ? "第 " + (st.ep || "") + " 集 · " : "") + dim;
    noteEl.textContent = noteText(getUid(), st.epLabel || "");

    if (!st.loaded) { body.innerHTML = '<div class="rw-load">加载中…</div>'; return; }

    var rows = st.rows || [];
    var uid = getUid();
    var mine = null, others = [];
    rows.forEach(function (r) {
      if (r.uid === uid) mine = r;
      else others.push(r);
    });
    others.sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });

    if (!rows.length) {
      body.innerHTML =
        '<div class="rw-empty"><div class="ico">📮</div>暂无评分与评论<br>来看过的追番人快点亮第一颗星吧</div>';
      return;
    }

    var sum = 0;
    rows.forEach(function (r) { sum += Number(r.score) || 0; });
    var avg = Math.round((sum / rows.length) * 10) / 10;

    var h = "";
    h += '<div class="rw-avg"><div class="num">' + avg + '<small> / 10</small></div><div class="meta">' +
      rows.length + ' 位追番人已评分<b style="display:block;color:#c6c9d4">' + dim + '</b></div></div>';

    if (mine) {
      h += '<div class="rw-item">' +
        '<div class="av">' + esc(shortNick(mine.nickname, mine.uid)) + '</div>' +
        '<div class="body">' +
        '<div class="who"><span class="nick">' + esc(mine.nickname || uid) + '</span><span class="me">我的评分</span><span class="t">' + timeAgo(mine.updatedAt || mine.createdAt) + '</span></div>' +
        '<div class="sc" style="margin-top:2px">' + halfStars(mine.score) + ' <span style="margin-left:6px">' + mine.score + ' 分</span></div>' +
        (mine.comment ? '<div class="cm">' + esc(mine.comment) + '</div>' : '<div style="margin-top:4px;font-size:11px;color:#7f8aa8">未附短评</div>') +
        "</div></div>";
    }

    if (!others.length) {
      h += '<div class="rw-empty" style="padding:20px"><div class="ico">✍️</div>暂无其他追番人的公开记录<br>每位追番人的评分都会同步展示在这里</div>';
    }

    others.forEach(function (r) {
      var nick = r.nickname || ("追番人 " + String(r.uid || "").slice(-4));
      h += '<div class="rw-item">' +
        '<div class="av">' + esc(shortNick(r.nickname, r.uid)) + '</div>' +
        '<div class="body">' +
        '<div class="who"><span class="nick" title="' + esc(r.uid || "") + '">' + esc(nick) + '</span><span class="t">' + timeAgo(r.updatedAt || r.createdAt) + '</span></div>' +
        '<div class="sc" style="margin-top:2px">' + halfStars(r.score) + ' <span style="margin-left:6px">' + r.score + ' 分</span></div>' +
        (r.comment ? '<div class="cm">' + esc(r.comment) + '</div>' : '<div style="margin-top:4px;font-size:11px;color:#5f6a86">已评分（未附短评）</div>') +
        "</div></div>";
    });

    body.innerHTML = h;
  }

  function shortNick(nick, uid) {
    var s = String(nick || "").trim() || ("追番人 " + String(uid || "").slice(-4));
    return s.slice(0, 2);
  }

  function open(animeId, type, ep, title) {
    ensureCSS(); ensureDom();
    _state = {
      animeId: String(animeId), type: type === "ep" ? "ep" : (type === "final" ? "final" : "open"),
      ep: String(ep == null || ep === "" ? "0" : ep), title: title || "", rows: [], loaded: false,
    };
    document.getElementById("rwMask").classList.add("show");
    document.getElementById("rwBody").innerHTML = '<div class="rw-load">加载中…</div>';
    loadWall();
  }
  function openBy(elOrEv) {
    var el = elOrEv && elOrEv.currentTarget ? elOrEv.currentTarget : elOrEv;
    if (!el) return;
    var animeId = el.getAttribute("data-anime");
    if (!animeId) return;
    var type = el.getAttribute("data-type") || "open";
    var ep = el.getAttribute("data-ep") || "0";
    var title = "";
    try {
      if (typeof currentAnime !== "undefined" && currentAnime && String(currentAnime.id) === animeId && currentAnime.title) title = currentAnime.title;
    } catch (e) { /* ignore */ }
    open(animeId, type, ep, title);
  }
  function close() {
    _state = null;
    var m = document.getElementById("rwMask");
    if (m) m.classList.remove("show");
  }

  function loadWall() {
    var st = _state;
    if (!st) return;
    var db = getDB();
    if (!db) { st.loaded = true; st.rows = []; render(); return; }
    var cond = { animeId: st.animeId, type: st.type, ep: st.ep, status: "normal" };
    db.collection(REVIEW_COLL).where(cond).limit(500).get()
      .then(function (r) {
        if (!_state || _state !== st) return;
        st.rows = (r && r.data) || [];
        st.loaded = true;
        render();
      })
      .catch(function () {
        if (!_state || _state !== st) return;
        st.rows = []; st.loaded = true; render();
      });
  }

  /** 历史功能「撤下公开短评」已下线：公开墙不再独立于个人档案存在 */
  function removeMine() {
    alert("「撤下公开短评」已下线。三端数据已同步一致：如需修改或删除评分，请到「我的追番」中操作，公开墙与管理后台会自动同步更新。");
  }

  window.DpccaReviewWall = {
    getUid: getUid,
    isRegistered: isRegistered,
    pushRating: pushRating,
    clearAnime: clearAnime,
    rebuildOnce: rebuildOnce,
    refreshAll: refreshAll,
    open: open,
    openBy: openBy,
    close: close,
    removeMine: removeMine,
  };
})();
