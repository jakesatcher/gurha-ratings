/* Password policy, shared by the server (require) and the browser (window.PasswordPolicy) so the
   on-screen checklist always matches what the server enforces. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PasswordPolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_LENGTH = 12;
  var MAX_LENGTH = 128;
  // Long passwords (what browser/password-manager generators produce, e.g. Chrome's 15-character
  // suggestions) don't need a special character, and may contain 3-character sequences (4+ is still
  // rejected). Length does more for strength than character tricks.
  var LONG_LENGTH = 15;
  // Allowed special characters. Everything else is rejected, including the characters most used in
  // XSS and SQL injection payloads:  < > ' " ` ; \ / & = % ( ) { } [ ] |  and whitespace.
  var SPECIALS = '!@#$^*_-+.,:?~';
  var BLOCKED_HINT = '< > \' " ` ; \\ / & = % ( ) { } [ ] | and spaces';

  function isSpecial(ch) {
    return SPECIALS.indexOf(ch) !== -1;
  }
  function isAllowed(ch) {
    return /[A-Za-z0-9]/.test(ch) || isSpecial(ch);
  }

  // Finds 3+ identical characters in a row ("aaa", "111"), ignoring case.
  function repeatedRun(pw) {
    var s = pw.toLowerCase();
    for (var i = 2; i < s.length; i++) {
      if (s[i] === s[i - 1] && s[i] === s[i - 2]) return s.slice(i - 2, i + 1);
    }
    return null;
  }

  // Finds a run of `len`+ consecutive letters or digits going up or down ("abc", "cba", "123", "321"),
  // ignoring case.
  function sequentialRun(pw, len) {
    var s = pw.toLowerCase();
    var kind = function (ch) { return /[a-z]/.test(ch) ? 'a' : /[0-9]/.test(ch) ? '0' : null; };
    var up = 1, down = 1;
    for (var i = 1; i < s.length; i++) {
      var sameKind = kind(s[i]) && kind(s[i]) === kind(s[i - 1]);
      var d = s.charCodeAt(i) - s.charCodeAt(i - 1);
      up = sameKind && d === 1 ? up + 1 : 1;
      down = sameKind && d === -1 ? down + 1 : 1;
      if (up >= len || down >= len) return s.slice(i - len + 1, i + 1);
    }
    return null;
  }
  // The longest allowed sequence: 2 normally, 3 for long passwords.
  function maxSequence(pw) {
    return pw.length >= LONG_LENGTH ? 3 : 2;
  }
  function needsSpecial(pw) {
    return pw.length < LONG_LENGTH;
  }

  var RULES = [
    { id: 'length', label: 'At least ' + MIN_LENGTH + ' characters', test: function (pw) { return pw.length >= MIN_LENGTH && pw.length <= MAX_LENGTH; } },
    { id: 'upper', label: 'At least 1 capital letter (A–Z)', test: function (pw) { return /[A-Z]/.test(pw); } },
    { id: 'lower', label: 'At least 1 lowercase letter (a–z)', test: function (pw) { return /[a-z]/.test(pw); } },
    { id: 'digit', label: 'At least 1 number (0–9)', test: function (pw) { return /[0-9]/.test(pw); } },
    { id: 'special', label: 'At least 1 special character: ' + SPECIALS.split('').join(' ') + ' (optional at ' + LONG_LENGTH + '+ characters)', test: function (pw) { return !needsSpecial(pw) || pw.split('').some(isSpecial); } },
    { id: 'allowed', label: 'No ' + BLOCKED_HINT, test: function (pw) { return pw.split('').every(isAllowed) && pw.indexOf('--') === -1; } },
    { id: 'repeat', label: 'No character repeated more than twice in a row (e.g. aaa, 111)', test: function (pw) { return !repeatedRun(pw); } },
    { id: 'sequence', label: 'No more than 2 letters or numbers in sequence (e.g. abc, cba, 123, 321); 3 allowed at ' + LONG_LENGTH + '+ characters', test: function (pw) { return !sequentialRun(pw, maxSequence(pw) + 1); } },
  ];

  // Returns a list of human-readable problems (empty when the password is acceptable).
  function check(pw) {
    pw = String(pw == null ? '' : pw);
    var problems = [];
    if (pw.length < MIN_LENGTH) problems.push('Password must be at least ' + MIN_LENGTH + ' characters.');
    if (pw.length > MAX_LENGTH) problems.push('Password must be at most ' + MAX_LENGTH + ' characters.');
    if (!/[A-Z]/.test(pw)) problems.push('Password needs at least 1 capital letter.');
    if (!/[a-z]/.test(pw)) problems.push('Password needs at least 1 lowercase letter.');
    if (!/[0-9]/.test(pw)) problems.push('Password needs at least 1 number.');
    if (needsSpecial(pw) && !pw.split('').some(isSpecial)) {
      problems.push('Password needs at least 1 special character (' + SPECIALS.split('').join(' ') + '), or make it ' + LONG_LENGTH + '+ characters.');
    }
    var bad = pw.split('').filter(function (ch, i, all) { return !isAllowed(ch) && all.indexOf(ch) === i; });
    if (bad.length) {
      problems.push('Password contains characters that aren\'t allowed: ' + bad.map(function (ch) { return /\s/.test(ch) ? 'space' : ch; }).join(' ') + '.');
    }
    if (pw.indexOf('--') !== -1) problems.push('Password can\'t contain two dashes in a row (--).');
    var rep = repeatedRun(pw);
    if (rep) problems.push('Password can\'t repeat a character more than twice in a row ("' + rep + '").');
    var seq = sequentialRun(pw, maxSequence(pw) + 1);
    if (seq) problems.push('Password can\'t have more than ' + maxSequence(pw) + ' letters or numbers in sequence ("' + seq + '").');
    return problems;
  }

  // For the `passwordrules` attribute, which Safari/iCloud Keychain, 1Password and other generators read
  // so their suggestions satisfy the policy (https://developer.apple.com/password-rules/).
  var PASSWORDRULES = 'minlength: ' + LONG_LENGTH + '; maxlength: ' + MAX_LENGTH + '; required: upper; required: lower; required: digit; ' +
    'required: [' + SPECIALS.replace('-', '') + '-]; allowed: [' + SPECIALS.replace('-', '') + '-]; max-consecutive: 2;';

  return {
    MIN_LENGTH: MIN_LENGTH, MAX_LENGTH: MAX_LENGTH, LONG_LENGTH: LONG_LENGTH, SPECIALS: SPECIALS,
    RULES: RULES, PASSWORDRULES: PASSWORDRULES, check: check,
  };
});
