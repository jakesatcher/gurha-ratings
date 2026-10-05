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
      scope.querySelectorAll('input[type="checkbox"][name="' + box.getAttribute('data-check-all') + '"]').forEach(function (c) { c.checked = box.checked; });
    });
  });

  document.querySelectorAll('[data-print]').forEach(function (b) {
    b.addEventListener('click', function () { window.print(); });
  });

  // Live weighted-score calculation on the rating form.
  var form = document.getElementById('rating-form');
  if (!form) return;
  var weights = JSON.parse(form.getAttribute('data-weights') || '[]');
  var levels = JSON.parse(form.getAttribute('data-levels') || '[]');

  function tier(level) {
    if (!level) return 'none';
    return level === 'BEG' ? 'beg' : level[0].toLowerCase();
  }

  function setLevel(el, level) {
    if (!el) return;
    el.textContent = level || '—';
    el.className = 'level level-' + tier(level);
  }

  function recalc() {
    var total = 0, wsum = 0, answered = 0;
    weights.forEach(function (c) {
      var checked = form.querySelector('input[name="score_' + c.id + '"]:checked');
      var fs = document.getElementById('cat-' + c.id);
      if (fs) fs.classList.toggle('answered', !!checked);
      if (checked) { total += Number(checked.value) * c.w; wsum += c.w; answered++; }
    });
    var score = wsum ? Math.round((total / wsum) * 100) / 100 : null;
    var level = score === null ? null : levels[Math.max(0, Math.min(levels.length - 1, Math.round(score)))];
    var text = score === null ? '—' : score.toFixed(2) + (answered < weights.length ? '*' : '');
    ['calc-score', 'bar-score'].forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = text; });
    setLevel(document.getElementById('calc-level'), level);
    setLevel(document.getElementById('bar-level'), level);
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
    ['independent_level', 'game_performance', 'final_level'].forEach(function (n) {
      if (!form.querySelector('input[name="' + n + '"]:checked')) missing.push(n.replace(/_/g, ' '));
    });
    if (missing.length) {
      e.preventDefault();
      window.alert('Please complete: \n• ' + missing.join('\n• '));
      return;
    }
    var gp = form.querySelector('input[name="game_performance"]:checked');
    var note = form.querySelector('textarea[name="game_performance_note"]');
    if (gp && (gp.value === 'sometimes' || gp.value === 'rarely') && note && !note.value.trim()) {
      e.preventDefault();
      window.alert('Please explain the game performance check when choosing "Sometimes" or "Rarely".');
      note.focus();
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
  input.addEventListener('input', update);
  if (confirm) confirm.addEventListener('input', update);
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
