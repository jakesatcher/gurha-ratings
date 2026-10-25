(function () {
  'use strict';

  // Confirmation prompts for destructive forms.
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Confirmation for individual submit buttons (e.g. delete inside an edit form).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-confirm-click]');
    if (btn && !window.confirm(btn.getAttribute('data-confirm-click'))) e.preventDefault();
  });

  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // "Select all" checkboxes: <input type="checkbox" data-check-all="name">
  document.querySelectorAll('[data-check-all]').forEach(function (box) {
    box.addEventListener('change', function () {
      var scope = box.closest('[data-check-scope]') || document;
      scope.querySelectorAll('input[type="checkbox"][name="' + box.getAttribute('data-check-all') + '"]').forEach(function (c) {
        if (!c.closest('[hidden]')) c.checked = box.checked; // filtered-out items stay as they are
      });
    });
  });

  document.querySelectorAll('[data-print]').forEach(function (b) {
    b.addEventListener('click', function () { window.print(); });
  });

  // Live weighted-score calculation on the rating form.
  var form = document.getElementById('rating-form');
  if (!form) return;
  var weights = JSON.parse(form.getAttribute('data-weights') || '[]');
  var bounds = JSON.parse(form.getAttribute('data-bounds') || '[]');

  function setLevel(el, band) {
    if (!el) return;
    el.textContent = band ? band.level : '—';
    el.className = 'level level-' + (band ? band.tier : 'none');
  }

  function recalc() {
    var total = 0, wsum = 0, answered = 0;
    weights.forEach(function (c) {
      var checked = form.querySelector('input[name="score_' + c.id + '"]:checked');
      var fs = document.getElementById('cat-' + c.id);
      if (fs) fs.classList.toggle('answered', !!checked);
      if (checked) { total += Number(checked.getAttribute('data-points')) * c.w; wsum += c.w; answered++; }
    });
    // Same rounding as the server: halves round up, nudged past floating-point error.
    var score = wsum ? Math.round((total / wsum) * 100 + 1e-9) / 100 : null;
    var points = score === null ? null : Math.round(score + 1e-9);
    var band = score === null ? null : bounds.filter(function (b) { return b.upper === null || points < b.upper; })[0];
    var text = score === null ? '—' : score.toFixed(2) + (answered < weights.length ? '*' : '');
    ['calc-score', 'bar-score'].forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = text; });
    setLevel(document.getElementById('calc-level'), band);
    setLevel(document.getElementById('bar-level'), band);
  }

  form.addEventListener('change', recalc);
  recalc();

  // Client-side check so raters see what's missing before submitting.
  form.addEventListener('submit', function (e) {
    var missing = [];
    weights.forEach(function (c) {
      if (!form.querySelector('input[name="score_' + c.id + '"]:checked')) {
        var legend = document.querySelector('#cat-' + c.id + ' legend');
        missing.push(legend ? legend.textContent.replace(/\s+/g, ' ').trim() : 'a category');
      }
    });
    if (missing.length) {
      e.preventDefault();
      window.alert('Please complete: \n• ' + missing.join('\n• '));
      return;
    }
    if (!form.action.includes('/admin/') && !window.confirm('Submit this rating? You can only rate each player once per season.')) {
      e.preventDefault();
    }
  });
})();

// Live password requirements checklist (rules come from password-policy.js, the same file the server uses).
(function () {
  'use strict';
  var input = document.querySelector('[data-password-input]');
  var list = document.querySelector('[data-password-rules]');
  if (!input || !list || !window.PasswordPolicy) return;
  var confirm = document.querySelector('[data-password-confirm]');
  list.classList.add('pw-live');
  function update() {
    var pw = input.value;
    window.PasswordPolicy.RULES.forEach(function (rule) {
      var li = list.querySelector('[data-rule="' + rule.id + '"]');
      if (li) li.classList.toggle('ok', pw.length > 0 && rule.test(pw));
    });
    var match = list.querySelector('[data-rule="match"]');
    if (match && confirm) match.classList.toggle('ok', pw.length > 0 && pw === confirm.value);
  }
  // Typing fires "input"; browser/password-manager suggestions may only fire "change" (or nothing, for
  // some autofill), so listen for both and re-check shortly after the fields gain or lose focus.
  [input, confirm].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', update);
    el.addEventListener('change', update);
    el.addEventListener('focus', function () { setTimeout(update, 300); });
    el.addEventListener('blur', update);
  });
  update();
  // Block submitting until everything is met, so people fix it before a round trip.
  input.form.addEventListener('submit', function (e) {
    var problems = window.PasswordPolicy.check(input.value);
    if (confirm && input.value !== confirm.value) problems.push('Passwords do not match.');
    if (problems.length) {
      e.preventDefault();
      window.alert(problems.join('\n'));
      input.focus();
    }
  });
})();

// Show/hide toggle on every password field.
(function () {
  'use strict';
  var fields = document.querySelectorAll('input[type="password"]');
  fields.forEach(function (input, i) {
    if (!input.id) input.id = 'pw-field-' + i;
    var wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-controls', input.id);
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Show password');
    wrap.appendChild(btn);
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    });
  });
  // Put fields back to hidden before submitting, so browsers treat them as passwords (saving,
  // not remembering them as form history).
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return; // blocked by validation: leave fields as the user had them
      form.querySelectorAll('.pw-wrap input').forEach(function (input) { input.type = 'password'; });
      form.querySelectorAll('.pw-toggle').forEach(function (b) { b.textContent = 'Show'; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Show password'); });
    });
  });
})();

// Paper form entry: live overall per row, "new paper rater" fields, scan preview.
(function () {
  var form = document.querySelector('form.paper-entry');
  if (!form) return;
  var weights = JSON.parse(form.getAttribute('data-weights') || '[]');
  var bounds = JSON.parse(form.getAttribute('data-bounds') || '[]');
  var totalW = weights.reduce(function (s, c) { return s + c.w; }, 0) || 1;

  function recalcRow(tr) {
    var sum = 0, filled = 0;
    weights.forEach(function (c) {
      var el = tr.querySelector('[data-cat="' + c.id + '"]');
      if (el && el.value !== '' && !isNaN(Number(el.value))) { sum += Number(el.value) * c.w; filled++; }
    });
    var out = tr.querySelector('[data-overall]');
    if (!out) return;
    if (filled !== weights.length) { out.textContent = filled ? '…' : '—'; return; }
    var score = Math.round((sum / totalW) * 100 + 1e-9) / 100;
    var points = Math.round(score + 1e-9);
    var lvl = bounds.filter(function (b) { return b.upper === null || points < b.upper; })[0].level;
    out.textContent = score.toFixed(2) + ' · ' + lvl;
  }
  form.querySelectorAll('[data-paper-row]').forEach(function (tr) {
    recalcRow(tr);
    tr.addEventListener('input', function () { recalcRow(tr); });
  });
  // Level cells: uppercase as you type.
  form.querySelectorAll('.cell-lvl').forEach(function (el) {
    el.addEventListener('input', function () { el.value = el.value.toUpperCase(); });
  });

  var sel = form.querySelector('[data-new-rater]');
  var fields = form.querySelector('[data-new-rater-fields]');
  function toggleNew() { if (fields) fields.hidden = !sel || sel.value !== 'new'; }
  if (sel) sel.addEventListener('change', toggleNew);
  toggleNew();

  var file = form.querySelector('[data-scan-preview]');
  var target = form.querySelector('[data-scan-target]');
  var lastUrl = null;
  if (file && target) {
    file.addEventListener('change', function () {
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      target.textContent = '';
      var f = file.files && file.files[0];
      if (!f) { target.hidden = true; return; }
      lastUrl = URL.createObjectURL(f);
      if (/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
        var img = document.createElement('img');
        img.src = lastUrl;
        img.alt = 'Scan preview';
        target.appendChild(img);
      } else {
        var a = document.createElement('a');
        a.href = lastUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open ' + f.name + ' to read along';
        target.appendChild(a);
      }
      target.hidden = false;
    });
  }
})();

