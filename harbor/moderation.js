/* Harbor content moderation helpers (client-side first line of defense) */
(function () {
  // Crisis / self-harm — show help resources, do not treat as hate-ban alone
  const CRISIS_RE = /\b(kill myself|end my life|suicide|suicidal|want to die|don't want to (?:be )?alive|dont want to (?:be )?alive|self[- ]?harm|cut myself|hang myself)\b/i;

  // Hate, slurs, violence promotion, discrimination, religious hate
  // Intentionally broad for a calm community; refine over time.
  const BLOCKED_PATTERNS = [
    // racial / ethnic slurs & hate
    /\b(nigger|nigga|kike|spic|chink|gook|wetback|coon|raghead|towelhead|tranny)\b/i,
    // homophobic / transphobic slurs
    /\b(faggot|fag\b|dyke\b|troon)\b/i,
    // ableist extreme slurs used as attacks
    /\b(retard(ed)?)\b/i,
    // direct violent threats / promotion
    /\b(i('ll| will) (kill|shoot|stab|murder) you)\b/i,
    /\b(kill all|death to|rape you|gas the|lynch)\b/i,
    /\b(bomb (the|a) |make a bomb|build a bomb)\b/i,
    // identity-based eliminationist hate
    /\b(hate (all )?(jews|muslims|christians|blacks|whites|gays|immigrants))\b/i,
    /\b(all (jews|muslims|christians|blacks|gays) (should|must) die)\b/i,
    // religious hate / desecration calls
    /\b(burn (all )?(churches|mosques|synagogues|temples))\b/i,
    /\b(kill (all )?(jews|muslims|christians|hindus|atheists))\b/i,
    // genocidal language
    /\b(genocide (is good|now)|ethnic cleansing)\b/i,
    // classic abuse leftovers
    /\b(piece of shit|go die|i hope you die|you should die)\b/i,
  ];

  const GUIDELINES = {
    title: 'Harbor Guidelines',
    summary: 'Harbor is a peaceful place. Be considerate, respectful, and thoughtful.',
    rules: [
      'Be considerate of others’ feelings and stories.',
      'Be respectful — no insults, harassment, or humiliation.',
      'Be thoughtful — share honestly without trying to harm.',
      'No hate speech, slurs, or discrimination of any kind.',
      'No promoting violence, threats, or harm toward anyone.',
      'No attacks on people for their religion, race, gender, orientation, or background.',
      'No politics fights or campaigning — keep Harbor calm.',
      'You may share gentle personal faith, but never use faith to demean others.',
      'If you’re in crisis, please seek real-world help — Harbor’s Angel is not emergency care.',
    ],
    legal: 'Harbor may remove content and restrict accounts that break these rules. Removed content and moderation actions may be retained in private records if needed for safety or legal reasons.',
  };

  function findBlocked(text) {
    const value = String(text || '');
    for (const re of BLOCKED_PATTERNS) {
      if (re.test(value)) {
        const m = value.match(re);
        return { blocked: true, match: m ? m[0] : 'blocked language' };
      }
    }
    return { blocked: false };
  }

  function isCrisis(text) {
    return CRISIS_RE.test(String(text || ''));
  }

  function deviceId() {
    const key = 'harbor.deviceId.v1';
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || `dev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(key, id);
      }
      return id;
    } catch (_) {
      return 'unknown-device';
    }
  }

  function guidelinesAccepted() {
    try { return localStorage.getItem('harbor.guidelines.v1') === 'accepted'; }
    catch (_) { return false; }
  }

  function acceptGuidelines() {
    try { localStorage.setItem('harbor.guidelines.v1', 'accepted'); }
    catch (_) {}
  }

  window.HarborMod = {
    GUIDELINES,
    CRISIS_RE,
    findBlocked,
    isCrisis,
    deviceId,
    guidelinesAccepted,
    acceptGuidelines,
  };
})();
