(function () {
  'use strict';

  var API = '/api/plugins/gp_importer';
  var LS_LAST_DIR = 'gp_importer_last_dir';
  var LS_DONE_VIEW = 'gp_importer_done_shown';

  var _view = 'start';
  var _files = [];
  var _pollTimer = null;
  var _navigateTimer = null;

  // ── Init ──
  function _init() {
    _setupListeners();
    _checkDeps();
    _restoreDir();

    var fb = window.feedBack || window.slopsmith;
    if (fb) {
      fb.on('screen:changed', function (screenId) {
        if (screenId === 'plugin-gp_importer') {
          if (_view === 'done') {
            _view = 'start';
            _showView('start');
          }
          _showView(_view);
        }
        var dd = document.getElementById('plugin-dropdown');
        if (dd) dd.classList.add('hidden');
      });
    }
  }

  function _setupListeners() {
    document.getElementById('gpiv-scan-btn').addEventListener('click', _onScan);

    document.getElementById('gpiv-import-btn').addEventListener('click', _onImport);
    document.getElementById('gpiv-select-all').addEventListener('click', function () {
      var cbs = document.querySelectorAll('#gpiv-table .gpiv-cb:not(:disabled)');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
      _updateSelectedCount();
    });
    document.getElementById('gpiv-deselect-all').addEventListener('click', function () {
      var cbs = document.querySelectorAll('#gpiv-table .gpiv-cb');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      _updateSelectedCount();
    });

    document.getElementById('gpiv-table').addEventListener('change', function (e) {
      if (e.target.classList.contains('gpiv-cb')) _updateSelectedCount();
    });

    var dirInput = document.getElementById('gpiv-dir');
    dirInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') _onScan();
    });
  }

  function _restoreDir() {
    try {
      var d = localStorage.getItem(LS_LAST_DIR);
      if (d) document.getElementById('gpiv-dir').value = d;
    } catch (e) {}
  }

  // ── Dependencies ──
  function _checkDeps() {
    var el = document.getElementById('gpiv-deps');
    fetch(API + '/deps')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var issues = [];
        if (!d.guitarpro) issues.push('Python guitarpro module unavailable');
        if (!d.fluidsynth) issues.push('fluidsynth not found on PATH');
        if (!d.soundfont) issues.push('No .sf2 soundfont found');
        if (!d.dlc_configured) issues.push('DLC directory not configured');

        if (issues.length) {
          el.innerHTML =
            '<div class="bg-red-900/50 border border-red-700 rounded px-3 py-2 text-red-200 text-xs">' +
            '\u26A0 ' + _esc(issues.join('; ')) + '</div>';
          document.getElementById('gpiv-scan-btn').disabled = true;
        } else {
          el.innerHTML =
            '<div class="bg-green-900/30 border border-green-700 rounded px-3 py-2 text-green-300 text-xs">' +
            '\u2713 All dependencies met (FluidSynth + GM soundfont ready)</div>';
          document.getElementById('gpiv-scan-btn').disabled = false;
        }
      })
      .catch(function (err) {
        el.innerHTML =
          '<div class="bg-red-900/50 border border-red-700 rounded px-3 py-2 text-red-200 text-xs">' +
          '\u26A0 Deps check failed: ' + _esc(err.message) + '</div>';
      });
  }

  // ── Scan ──
  function _onScan() {
    var dir = document.getElementById('gpiv-dir').value.trim();
    if (!dir) return;

    try { localStorage.setItem(LS_LAST_DIR, dir); } catch (e) {}

    var btn = document.getElementById('gpiv-scan-btn');
    btn.disabled = true;
    btn.textContent = 'Scanning\u2026';
    _hideError();

    fetch(API + '/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: dir }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Scan failed'); });
        return r.json();
      })
      .then(function (data) {
        _files = data.files || [];
        _renderFiles(data);
        _showView('files');
      })
      .catch(function (err) {
        _showError(err.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Scan';
      });
  }

  function _renderFiles(data) {
    document.getElementById('gpiv-dir-label').textContent = data.directory || '';

    var total = data.total || 0;
    var imported = 0;
    for (var i = 0; i < _files.length; i++) {
      if (_files[i].already_imported) imported++;
    }
    document.getElementById('gpiv-count').textContent =
      total + ' file' + (total !== 1 ? 's' : '') +
      (imported ? ' (' + imported + ' already imported)' : '');

    var container = document.getElementById('gpiv-table');
    if (!_files.length) {
      container.innerHTML = '<div class="text-gray-500 text-sm py-4">No GP files found.</div>';
      return;
    }

    var html = '<table class="w-full text-sm">' +
      '<thead><tr class="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-700">' +
      '<th class="text-left py-2 pr-2 w-8"></th>' +
      '<th class="text-left py-2 pr-3">Song</th>' +
      '<th class="text-left py-2 pr-3">Arrangements</th>' +
      '<th class="text-right py-2 pr-3">Duration</th>' +
      '<th class="text-right py-2 pr-3">Status</th>' +
      '</tr></thead><tbody>';

    for (var idx = 0; idx < _files.length; idx++) {
      var f = _files[idx];
      var checked = !f.already_imported ? 'checked' : '';
      var disabled = f.parse_error ? 'disabled' : '';
      var rowClass = f.already_imported ? 'opacity-50' : '';
      var title = f.title || _filename(f.path);
      var dur = f.duration ? _fmtDuration(f.duration) : '\u2014';

      var arrNames = [];
      var tracks = f.tracks || [];
      for (var t = 0; t < tracks.length; t++) {
        if (tracks[t].selected) {
          arrNames.push(tracks[t].assigned_name || tracks[t].name);
        }
      }
      var arrStr = arrNames.length ? arrNames.join(', ') : '\u2014';

      var badge = '';
      if (f.parse_error) {
        badge = '<span class="text-red-400 text-xs" title="' + _esc(f.parse_error) + '">Parse Error</span>';
      } else if (f.already_imported) {
        badge = '<span class="text-yellow-400 text-xs">Imported</span>';
      } else {
        badge = '<span class="text-green-400 text-xs">New</span>';
      }

      html += '<tr class="border-b border-gray-800 ' + rowClass + '">' +
        '<td class="py-2 pr-2"><input type="checkbox" class="gpiv-cb" data-idx="' + idx + '" ' + checked + ' ' + disabled + '></td>' +
        '<td class="py-2 pr-3">' +
        '<div class="text-gray-200">' + _esc(title) + '</div>' +
        (f.artist ? '<div class="text-gray-500 text-xs">' + _esc(f.artist) + '</div>' : '') +
        '</td>' +
        '<td class="py-2 pr-3 text-gray-400 text-xs">' + _esc(arrStr) + '</td>' +
        '<td class="py-2 pr-3 text-gray-400 text-xs text-right">' + dur + '</td>' +
        '<td class="py-2 pr-3 text-right">' + badge + '</td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
    _updateSelectedCount();
  }

  // ── Selection ──
  function _updateSelectedCount() {
    var cbs = document.querySelectorAll('#gpiv-table .gpiv-cb:checked');
    var btn = document.getElementById('gpiv-import-btn');
    var n = cbs.length;
    btn.textContent = n ? 'Import Selected (' + n + ')' : 'Import Selected';
    btn.disabled = n === 0;
  }

  // ── Import ──
  function _onImport() {
    var cbs = document.querySelectorAll('#gpiv-table .gpiv-cb:checked');
    var paths = [];
    for (var i = 0; i < cbs.length; i++) {
      var idx = parseInt(cbs[i].getAttribute('data-idx'), 10);
      if (!isNaN(idx) && _files[idx]) paths.push(_files[idx].path);
    }
    if (!paths.length) return;

    document.getElementById('gpiv-import-btn').disabled = true;
    _showView('importing');
    _resetProgress();

    fetch(API + '/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: paths }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Import rejected'); });
        return r.json();
      })
      .then(function () {
        _pollTimer = setInterval(_pollStatus, 500);
      })
      .catch(function (err) {
        _setMessage('Error: ' + err.message, 'text-red-400');
      });
  }

  function _pollStatus() {
    fetch(API + '/status')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        _updateProgress(s);
        if (s.running) return;

        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        _view = 'done';
        _showResults(s.results || []);

        _navigateTimer = setTimeout(function () {
          fetch('/api/rescan', { method: 'POST' }).catch(function () {});
          if (window.showScreen) window.showScreen('home');
        }, 3000);
      })
      .catch(function (err) {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        _setMessage('Status poll failed: ' + err.message, 'text-red-400');
      });
  }

  function _resetProgress() {
    document.getElementById('gpiv-progress-file').textContent = '';
    document.getElementById('gpiv-progress-fill').style.width = '0%';
    document.getElementById('gpiv-results').classList.add('hidden');
    _setMessage('Starting\u2026', 'text-gray-400');
  }

  function _updateProgress(s) {
    var pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    document.getElementById('gpiv-progress-fill').style.width = pct + '%';
    document.getElementById('gpiv-progress-file').textContent = s.current_file || '';
    _setMessage(s.message || '', 'text-gray-400');
  }

  function _showResults(results) {
    var container = document.getElementById('gpiv-results');
    container.classList.remove('hidden');

    var ok = 0;
    for (var i = 0; i < results.length; i++) {
      if (results[i].success) ok++;
    }
    var fail = results.length - ok;

    var html = '<div class="mb-3 text-sm">' +
      '<span class="text-green-400 font-medium">' + ok + ' succeeded</span>' +
      (fail ? ', <span class="text-red-400 font-medium">' + fail + ' failed</span>' : '') +
      ' \u2014 redirecting to library\u2026</div>';

    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      var label = r.title || _filename(r.file);
      if (r.success) {
        html += '<div class="flex items-center gap-2 text-xs py-0.5">' +
          '<span class="text-green-400 shrink-0">\u2713</span>' +
          '<span class="text-gray-300">' + _esc(label) + '</span>' +
          '<span class="text-gray-600">\u2192</span>' +
          '<span class="text-gray-500 truncate">' + _esc(r.feedpak || '') + '</span>' +
          '</div>';
      } else {
        html += '<div class="flex items-start gap-2 text-xs py-0.5">' +
          '<span class="text-red-400 shrink-0">\u2717</span>' +
          '<div>' +
          '<span class="text-gray-300">' + _esc(label) + '</span>' +
          '<div class="text-red-400">' + _esc(r.error || 'Unknown error') + '</div>' +
          '</div></div>';
      }
    }

    document.getElementById('gpiv-results-list').innerHTML = html;
    _setMessage('Import complete', 'text-green-400');
  }

  // ── View switching ──
  function _showView(view) {
    if (view === _view && _view !== 'start') return;
    if (_navigateTimer) { clearTimeout(_navigateTimer); _navigateTimer = null; }
    _view = view;
    document.getElementById('gpiv-start').style.display = view === 'start' ? '' : 'none';
    document.getElementById('gpiv-files').style.display = view === 'files' ? '' : 'none';
    document.getElementById('gpiv-progress').style.display =
      (view === 'importing' || view === 'done') ? '' : 'none';
  }

  // ── Helpers ──
  function _filename(path) {
    if (!path) return '';
    var parts = path.split('/');
    return parts[parts.length - 1];
  }

  function _fmtDuration(sec) {
    if (!sec || sec <= 0) return '\u2014';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _showError(msg) {
    var el = document.getElementById('gpiv-scan-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function _hideError() {
    document.getElementById('gpiv-scan-error').classList.add('hidden');
  }

  function _setMessage(msg, cls) {
    var el = document.getElementById('gpiv-progress-message');
    el.textContent = msg;
    el.className = (cls || 'text-gray-400') + ' text-xs mt-1';
  }

  // ── Bootstrap ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
