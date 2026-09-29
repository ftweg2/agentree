// 加载页面：轮询桌面壳的启动状态，出错时显示原因、后端输出和“重试”按钮。
// 就绪后由桌面壳把窗口导航到后端地址，这里不需要处理跳转。
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var card = $('card');
  var retryBtn = $('retry');
  var lastLogs = '';
  var polling = false;

  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (t && t.core && t.core.invoke) return t.core.invoke(cmd, args || {});
    return Promise.reject(new Error('Tauri 接口不可用'));
  }

  function setMeta(s) {
    var rows = [];
    rows.push(['地址', s.url]);
    rows.push(['项目目录', s.root]);
    if (s.command) rows.push(['启动命令', s.command]);
    if (s.commandSource) rows.push(['命令来源', s.commandSource]);
    if (s.pid) rows.push(['后端进程', 'PID ' + s.pid]);
    var dl = $('meta');
    dl.textContent = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt');
      dt.textContent = r[0];
      var dd = document.createElement('dd');
      dd.textContent = r[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  function render(s) {
    card.setAttribute('data-phase', s.phase);
    $('title').textContent = s.title;
    var msg = s.message;
    if (s.phase === 'starting' && s.elapsedMs > 1500) {
      msg += '（' + Math.floor(s.elapsedMs / 1000) + ' 秒）';
    }
    $('message').textContent = msg;
    $('bar').style.width = Math.min(100, (s.elapsedMs / s.timeoutMs) * 100) + '%';

    var hint = $('hint');
    hint.hidden = !s.hint;
    hint.textContent = s.hint || '';

    setMeta(s);

    var box = $('logs-box');
    var text = (s.logs || []).join('\n');
    box.hidden = text.length === 0;
    if (text !== lastLogs) {
      var pre = $('logs');
      pre.textContent = text;
      pre.scrollTop = pre.scrollHeight;
      lastLogs = text;
    }
    $('logs-summary').textContent = s.phase === 'error'
      ? '后端输出（最后 ' + s.logs.length + ' 行）'
      : '后端输出';
    if (s.phase === 'error') box.open = true;

    $('actions').hidden = s.phase !== 'error';
    retryBtn.disabled = false;
    document.title = s.phase === 'error' ? 'agentree - 启动失败' : 'agentree';
  }

  function poll() {
    if (polling) return;
    polling = true;
    invoke('get_status')
      .then(render)
      .catch(function (e) {
        $('title').textContent = '无法获取启动状态';
        $('message').textContent = String(e && e.message || e);
      })
      .then(function () {
        polling = false;
      });
  }

  retryBtn.addEventListener('click', function () {
    retryBtn.disabled = true;
    invoke('retry').then(poll, poll);
  });

  poll();
  setInterval(poll, 400);
})();
