// Résumé IA — related-list widget on the Zoho CRM Account page.
//
// Reads and generates summaries through the account-summary edge function. The
// call goes through a Zoho Connection, which adds the API key on Zoho's side.
// A next step's task actions (create, close, update) run here, through the CRM
// SDK, as the signed-in user; declining a quote goes through the function,
// which writes to Zoho Books.

(function () {
  'use strict';

  var CONNECTION = 'affichez_resume_ia';
  /**
   * card.html: the business-card slot at the top of the Account page, which Zoho
   * caps at 500 px. The summary there is one panel under tabs instead of a
   * column of sections; widget.html (the related list) keeps the full layout.
   */
  var COMPACT = document.body.getAttribute('data-layout') === 'compact';
  var COMPACT_MAX_HEIGHT = 500;
  /**
   * Zoho pads the business-card frame 15 px top and bottom inside the height it
   * is given (border-box), so the card sees the asked height less 30.
   */
  var COMPACT_INSET = 30;
  /**
   * Compact layout only: the profiles that see the top card while it is piloted;
   * empty for everyone. Zoho shows the slot only once the card asks for a height,
   * so for any other profile it stays hidden. The extension itself cannot be
   * limited to profiles.
   */
  var PILOT_PROFILES = [];
  var ENDPOINT = 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/account-summary';
  var POLL_MS = 3000;
  var POLL_LIMIT_MS = 8 * 60 * 1000;   // the function gives up on a run after 7 minutes
  var POLL_MAX_FAILURES = 5;

  var TEMPERATURE = {
    chaud: { label: 'Chaud', tone: 'hot', icon: 'flame' },
    client_actif: { label: 'Client actif', tone: 'good', icon: 'star' },
    tiede: { label: 'Tiède', tone: 'warn', icon: 'thermo' },
    froid: { label: 'Froid', tone: 'cold', icon: 'snow' },
    dormant: { label: 'Dormant', tone: 'idle', icon: 'moon' },
    a_risque: { label: 'À risque', tone: 'critical', icon: 'alert' },
  };
  var POINT_TONE = {
    positif: { label: 'Positif', tone: 'good', icon: 'check' },
    attention: { label: 'À surveiller', tone: 'warn', icon: 'alert' },
    neutre: { label: 'Neutre', tone: 'idle', icon: 'info' },
  };
  var KIND = {
    account: 'fiche', contact: 'contact', email: 'courriel', note: 'note', task: 'tâche',
    meeting: 'rencontre', quote: 'devis', invoice: 'facture', credit_note: 'note de crédit',
  };
  var KIND_ICON = {
    account: 'building', contact: 'user', email: 'mail', note: 'note', task: 'task',
    meeting: 'calendar', quote: 'quote', invoice: 'dollar', credit_note: 'dollar',
  };

  /** What each kind of next step offers. A step from before actions existed is create_task. */
  var ACTION = {
    create_task: { button: 'Créer la tâche', icon: 'plus', busy: 'Création…', failed: 'Tâche non créée' },
    close_task: { button: 'Fermer la tâche', icon: 'check', busy: 'Fermeture…', confirm: 'Confirmer la fermeture', failed: 'Tâche non fermée' },
    update_task: { button: 'Mettre à jour la tâche', icon: 'calendar', busy: 'Mise à jour…', failed: 'Tâche non mise à jour' },
    decline_quote: { button: 'Marquer refusé', icon: 'x', busy: 'Envoi à Zoho Books…', confirm: 'Confirmer le refus', failed: 'Devis non modifié' },
    revise_quote: { button: 'Modifier dans Books', icon: 'external' },
  };
  /**
   * The closed option of Tasks.Status, by its actual value. Records are written
   * with the option's label ("Achevé" in this org): the actual value itself is
   * stored as a stray word, and Zoho leaves the task open (no Closed_Time).
   */
  var TASK_COMPLETED = 'Completed';
  var CONFIRM_MS = 8000;

  var state = {
    accountId: '',
    accountName: '',
    user: null,
    data: null,          // { summary, running, failed } from the function
    error: null,         // message of the last failed call
    pollStarted: 0,
    pollTimer: null,
    pollFailures: 0,
    doneSteps: {},       // "<summary id>:<step index>" → { label, open }, for this page view
    busySteps: {},       // same key → true while the action runs
    confirming: null,    // the key of the step waiting for its confirmation click
    tab: 'synth',        // compact layout: the panel on show
    openRef: null,       // "<point or step>:<source id>" of the note or email shown in place
  };

  var root = document.getElementById('root');

  // ─── Formatting ─────────────────────────────────────────────────────────────

  var money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
  var shortDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', timeZone: 'America/Toronto' });
  var shortDateYear = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Toronto' });

  function parseDate(value) {
    if (!value) return null;
    // A plain date is a calendar day: read it at noon so no timezone moves it.
    var d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00') : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(value) {
    var d = parseDate(value);
    if (!d) return '';
    return d.getFullYear() === new Date().getFullYear() ? shortDate.format(d) : shortDateYear.format(d);
  }

  function ago(value) {
    var d = parseDate(value);
    if (!d) return '';
    var min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'à l’instant';
    if (min < 60) return 'il y a ' + min + ' min';
    var h = Math.round(min / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    var days = Math.round(h / 24);
    if (days < 31) return 'il y a ' + days + ' j';
    return 'le ' + fmtDate(value);
  }

  function plural(n, one, many) {
    return n + ' ' + (n > 1 ? many : one);
  }

  function capitalize(text) {
    return String(text).replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // ─── DOM ────────────────────────────────────────────────────────────────────

  function svg(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  var ICONS = {
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    sparkle: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
    calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    flame: svg('<path d="M12 3c.9 3.2 4.9 5.2 4.9 10A4.9 4.9 0 0 1 7.1 13c0-2.1 1-3.5 2.2-4.7.3 1.5 1 2.5 2.2 3C11 8.8 11 5.9 12 3z"/>'),
    star: svg('<path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>'),
    thermo: svg('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 11v6"/>'),
    snow: svg('<path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17"/><path d="M9.5 3.5L12 5l2.5-1.5M9.5 20.5L12 19l2.5 1.5"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
    alert: svg('<path d="M10.3 3.9L2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>'),
    note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
    task: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    quote: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>'),
    dollar: svg('<path d="M12 2.5v19M16.5 6.5C15.7 5 14 4.3 12 4.3c-2.7 0-4.5 1.3-4.5 3.3 0 4.8 9 2.4 9 7.2 0 2.1-2 3.4-4.5 3.4-2.3 0-4-.9-4.8-2.4"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'),
    building: svg('<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3"/>'),
    link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    external: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  };

  /** Constant markup from ICONS only, never data. */
  function icon(name) {
    var el = document.createElement('span');
    el.className = 'ico';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = ICONS[name];
    return el;
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    [].concat(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  var lastHeight = 0;
  /**
   * Set when the card starts, after PageLoad: Zoho loses a Resize sent earlier,
   * and a top card outside the pilot never sends one, so its slot stays hidden.
   */
  var sdkReady = false;

  /**
   * Fits the frame to the card. Measured on the card, not the body: the body is
   * at least as tall as the frame, so it could never shrink. A height Zoho did
   * not take is asked again on the next change.
   */
  function resize() {
    if (!sdkReady) return;
    var height = Math.ceil(root.getBoundingClientRect().height) + 4 + (COMPACT ? COMPACT_INSET : 0);
    if (COMPACT) height = Math.min(height, COMPACT_MAX_HEIGHT);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    try {
      var asked = ZOHO.CRM.UI.Resize({ height: String(height), width: String(document.documentElement.clientWidth) });
      if (asked && asked.catch) asked.catch(function () { lastHeight = 0; });
    } catch (e) {
      lastHeight = 0;   // not in a resizable location
    }
  }

  // The card's height changes after a render too: the web font loading, text
  // re-wrapping when Zoho resizes the frame's width.
  if (window.ResizeObserver) new ResizeObserver(resize).observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resize);
  // The top slot loads the frame hidden, at no width, and shows it once a height
  // is asked: the card is measured again at its real width.
  window.addEventListener('resize', resize);

  // ─── Backend ────────────────────────────────────────────────────────────────

  function errorText(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return obj.error || obj.message || obj.msg || (obj.code && obj.code !== 'SUCCESS' ? String(obj.code) : null);
  }

  /** The Connection wraps the remote answer; find the function's JSON in it. */
  function parseBody(res) {
    var d = res && res.details;
    var body = d && d.statusMessage !== undefined ? d.statusMessage
      : d && d.response !== undefined ? d.response
      : d && d.output !== undefined ? d.output
      : d !== undefined ? d : res;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { throw new Error('Réponse illisible du service de résumé.'); }
    }
    return body;
  }

  /**
   * Anything that is not a { summary, running, failed } answer is an error,
   * so a gateway or Zoho error page never replaces the card's data.
   */
  function unwrap(res) {
    var body = parseBody(res);
    if (body && typeof body === 'object' && !body.error && ('summary' in body || 'running' in body || 'failed' in body)) {
      return { summary: body.summary || null, running: body.running || null, failed: body.failed || null };
    }
    throw new Error(errorText(body) || errorText(res) || 'Réponse inattendue du service de résumé.');
  }

  function invoke(payload) {
    return ZOHO.CRM.CONNECTION.invoke(CONNECTION, {
      url: ENDPOINT,
      method: 'POST',
      param_type: 2,
      parameters: payload,
      headers: { 'Content-Type': 'application/json' },
    }).then(function (res) {
      if (window.console && console.debug) console.debug('[ResumeIA]', res);
      return res;
    });
  }

  function call(payload) {
    return invoke(payload).then(unwrap);
  }

  /** An action's answer: { ok, error? }. */
  function callAction(payload) {
    return invoke(payload).then(function (res) {
      var body = parseBody(res);
      if (body && typeof body === 'object' && typeof body.ok === 'boolean') return body;
      throw new Error(errorText(body) || errorText(res) || 'Réponse inattendue du service de résumé.');
    });
  }

  function load() {
    return call({ action: 'get', account_id: state.accountId })
      .then(function (data) {
        state.data = data;
        state.error = null;
        state.pollFailures = 0;
        if (data.running) schedulePoll(POLL_MS); else stopPolling();
      })
      .catch(function (err) {
        // While a generation runs, a failed check is retried with a growing delay.
        if (state.data && state.data.running && ++state.pollFailures < POLL_MAX_FAILURES) {
          schedulePoll(POLL_MS * (state.pollFailures + 1));
          return;
        }
        state.error = err && err.message ? err.message : String(err);
        if (state.data) state.data.running = null;
        stopPolling();
      })
      .then(render);
  }

  function generate() {
    state.error = null;
    state.openRef = null;
    stopPolling();
    state.data = Object.assign({}, state.data || {}, { running: { created_at: new Date().toISOString() }, failed: null });
    render();
    call({ action: 'generate', account_id: state.accountId, user: state.user || {} })
      .then(function (data) {
        state.data = data;
        if (data.running) schedulePoll(POLL_MS);
      })
      .catch(function (err) {
        state.error = err && err.message ? err.message : String(err);
        if (state.data) state.data.running = null;
      })
      .then(render);
  }

  /** One check at a time: the next is scheduled when the previous answers. */
  function schedulePoll(delay) {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (!state.pollStarted) state.pollStarted = Date.now();
    if (Date.now() - state.pollStarted > POLL_LIMIT_MS) {
      stopPolling();
      if (state.data) state.data.running = null;
      state.error = 'La génération prend plus de temps que prévu. Rechargez la fiche dans un moment.';
      return;
    }
    state.pollTimer = setTimeout(load, delay);
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.pollStarted = 0;
    state.pollFailures = 0;
  }

  // ─── CRM actions ────────────────────────────────────────────────────────────

  function openSource(src) {
    if (src.module && src.record_id) {
      ZOHO.CRM.UI.Record.open({ Entity: src.module, RecordID: src.record_id, Target: '_blank' })
        .catch(function () { if (src.url) window.open(src.url, '_blank', 'noopener'); });
    } else if (src.url) {
      window.open(src.url, '_blank', 'noopener');
    }
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** The suggested delay counted from today, moved off the weekend. */
  function stepDue(step) {
    if (typeof step.due_in_days !== 'number') return step.due_date;
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + Math.max(0, step.due_in_days));
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function actionOf(step) {
    return ACTION[step.action] ? step.action : 'create_task';
  }

  /** The SDK's answer to a write: its first row, or the reason Zoho gave. */
  function written(res) {
    var row = res && res.data && res.data[0];
    if (!row || row.code !== 'SUCCESS') throw new Error((row && row.message) || 'Modification refusée par Zoho.');
    return row;
  }

  /** A task's description with one more line, so its history stays readable. */
  function appendLine(description, line) {
    var text = String(description || '').trim();
    return (text ? text + '\n\n' : '') + line;
  }

  /** The task as it is now: the card may be hours old. */
  function currentTask(id) {
    return ZOHO.CRM.API.getRecord({ Entity: 'Tasks', RecordID: id }).then(function (res) {
      var task = res && res.data && res.data[0];
      if (!task) throw new Error('tâche introuvable, elle a peut-être été supprimée.');
      return task;
    });
  }

  var completedLabel = null;

  /** The label to write for a closed task, read from the field's options once. */
  function taskCompletedLabel() {
    if (completedLabel) return Promise.resolve(completedLabel);
    return ZOHO.CRM.META.getFields({ Entity: 'Tasks' }).then(function (res) {
      var field = ((res && res.fields) || []).filter(function (f) { return f.api_name === 'Status'; })[0];
      var option = field && (field.pick_list_values || []).filter(function (v) { return v.actual_value === TASK_COMPLETED; })[0];
      if (!option || !option.display_value) throw new Error('statut « terminé » introuvable dans Zoho.');
      completedLabel = option.display_value;
      return completedLabel;
    });
  }

  function openTask(id) {
    return function () { openSource({ module: 'Tasks', record_id: id }); };
  }

  function openUrl(url) {
    return function () { if (url) window.open(url, '_blank', 'noopener'); };
  }

  var RUN = {
    create_task: function (step) {
      var data = {
        Subject: step.title,
        Due_Date: stepDue(step),
        What_Id: state.accountId,
        $se_module: 'Accounts',
        Description: appendLine(step.reason, 'Créée depuis le résumé IA du compte.'),
      };
      if (step.contact_id) data.Who_Id = step.contact_id;
      return ZOHO.CRM.API.insertRecord({ Entity: 'Tasks', APIData: data, Trigger: ['workflow'] })
        .then(written)
        .then(function (row) { return { label: 'Tâche créée', open: openTask(row.details && row.details.id) }; });
    },

    close_task: function (step) {
      var id = step.target.record_id;
      return Promise.all([currentTask(id), taskCompletedLabel()]).then(function (got) {
        var task = got[0];
        if (task.Closed_Time) return { label: 'Déjà fermée', open: openTask(id) };
        return ZOHO.CRM.API.updateRecord({
          Entity: 'Tasks',
          APIData: { id: id, Status: got[1], Description: appendLine(task.Description, 'Fermée depuis le résumé IA du compte : ' + step.reason) },
          Trigger: ['workflow'],
        }).then(written).then(function () { return { label: 'Tâche fermée', open: openTask(id) }; });
      });
    },

    update_task: function (step) {
      var id = step.target.record_id;
      return currentTask(id).then(function (task) {
        if (task.Closed_Time) throw new Error('cette tâche est déjà fermée.');
        var data = { id: id, Due_Date: stepDue(step), Description: appendLine(task.Description, 'Mise à jour depuis le résumé IA du compte : ' + step.reason) };
        if (step.new_subject) data.Subject = step.new_subject;
        return ZOHO.CRM.API.updateRecord({ Entity: 'Tasks', APIData: data, Trigger: ['workflow'] })
          .then(written)
          .then(function () { return { label: 'Tâche mise à jour', open: openTask(id) }; });
      });
    },

    decline_quote: function (step, index, summary) {
      return callAction({ action: 'quote_decline', account_id: state.accountId, summary_id: summary.id, step: index, user: state.user || {} })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || 'refus non enregistré.');
          return { label: res.already ? 'Déjà refusé' : 'Devis refusé', open: openUrl(step.target.url) };
        });
    },
  };

  /**
   * Runs a step's action. Closing a task and declining a quote take a second
   * click, which expires on its own.
   */
  function act(step, index, summary) {
    var key = summary.id + ':' + index;
    var action = actionOf(step);
    if (action === 'revise_quote') {
      openUrl(step.target.url && step.target.url + '/edit')();
      return;
    }
    if (ACTION[action].confirm && state.confirming !== key) {
      state.confirming = key;
      render();
      setTimeout(function () {
        if (state.confirming === key) { state.confirming = null; render(); }
      }, CONFIRM_MS);
      return;
    }
    state.confirming = null;
    state.busySteps[key] = true;
    state.error = null;
    render();
    RUN[action](step, index, summary)
      .then(function (done) { state.doneSteps[key] = done; })
      .catch(function (err) {
        var text = err && err.message ? err.message : String(err);
        state.error = ACTION[action].failed + ' : ' + text;
      })
      .then(function () { delete state.busySteps[key]; render(); });
  }

  function cancelConfirm() {
    state.confirming = null;
    render();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function tag(iconName, text, extra) {
    return h('span', { class: 'tag' + (extra ? ' ' + extra : '') }, [icon(iconName), text]);
  }

  /** A document by its number, anything else by its date: "devis SOUMQC-028810", "note · 19 oct.". */
  function sourceLabel(src) {
    var kind = KIND[src.kind] || 'source';
    if (src.number) return kind + ' ' + src.number;
    return kind + (src.date ? ' · ' + fmtDate(src.date) : '');
  }

  /** A note or an email the card shows itself: Zoho has no page for a single note. */
  function hasPreview(src) {
    return !!src.preview && (src.kind === 'note' || src.kind === 'email');
  }

  /** Nothing to open: the account is this page, and so is a note on it from a card without previews. */
  function onThisPage(src) {
    return src.kind === 'account' || (src.module === 'Accounts' && src.record_id === state.accountId);
  }

  /**
   * The cited items under a point or a step (`ctx`). A note or an email opens in
   * place (refPreview); anything else opens its own record in a new tab.
   */
  function sourceLinks(ids, sources, ctx) {
    var refs = (ids || []).filter(function (id) { return sources && sources[id]; });
    if (!refs.length) return null;
    return h('div', { class: 'srcs' }, refs.map(function (id) {
      var src = sources[id];
      var text = sourceLabel(src);
      var body = [icon(KIND_ICON[src.kind] || 'link'), text];
      var title = src.label || capitalize(text);
      if (hasPreview(src)) {
        var key = ctx + ':' + id;
        var open = state.openRef === key;
        return h('button', {
          class: 'src' + (open ? ' is-on' : ''), type: 'button', title: title, 'aria-expanded': open ? 'true' : 'false',
          onclick: function () { state.openRef = open ? null : key; render(); revealPreview(); },
        }, body);
      }
      if (onThisPage(src)) {
        var here = src.kind === 'account' ? 'Champs et chiffres de cette fiche' : title + ' : dans les Notes de cette fiche';
        return h('span', { class: 'src is-static', title: here }, body);
      }
      return h('button', { class: 'src', type: 'button', title: 'Ouvrir : ' + title, onclick: function () { openSource(src); } }, body);
    }));
  }

  /**
   * Compact layout: scrolls the tab panel, and only it, until an opened preview's
   * foot is in view, never past its top. scrollIntoView could scroll Zoho's page.
   */
  function revealPreview() {
    var panel = root.querySelector('.tab-panel');
    var box = panel && panel.querySelector('.ref-preview');
    if (!box) return;
    var view = panel.getBoundingClientRect();
    var rect = box.getBoundingClientRect();
    var below = rect.bottom - view.bottom;
    if (below > 0) panel.scrollTop += Math.min(below + 8, rect.top - view.top);
  }

  /** The note or email opened from one of `ids`, with the text the summary was written from. */
  function refPreview(ids, sources, ctx) {
    var key = state.openRef;
    if (!key || key.indexOf(ctx + ':') !== 0) return null;
    var id = key.slice(ctx.length + 1);
    var src = (ids || []).indexOf(id) >= 0 && sources ? sources[id] : null;
    if (!src || !hasPreview(src)) return null;
    var p = src.preview;
    var where = p.where
      ? h('button', { class: 'ref-open', type: 'button', onclick: function () { openSource(src); } },
        [icon('external'), 'Ouvrir ' + (/^tâche/.test(p.where) ? 'la ' : 'le ') + p.where])
      : h('span', { text: 'Dans la liste Notes de cette fiche' });
    return h('div', { class: 'ref-preview', role: 'region', 'aria-label': src.label || capitalize(sourceLabel(src)) }, [
      h('div', { class: 'ref-head' }, [
        icon(KIND_ICON[src.kind] || 'link'),
        h('span', { class: 'ref-label', text: src.label || capitalize(sourceLabel(src)), title: src.label || null }),
        src.date ? h('span', { class: 'ref-date', text: fmtDate(src.date) }) : null,
        h('button', {
          class: 'ref-close', type: 'button', title: 'Fermer', 'aria-label': 'Fermer',
          onclick: function () { state.openRef = null; render(); },
        }, icon('x')),
      ]),
      p.title ? h('div', { class: 'ref-title', text: (src.kind === 'email' ? 'Objet : ' : '') + p.title }) : null,
      p.text
        ? h('div', { class: 'ref-text', text: p.text })
        : h('p', {
          class: 'ref-empty',
          text: src.kind === 'note' ? 'Cette note n’a pas de texte.'
            : p.text === '' ? 'Ce courriel ne contient aucun texte.'
            : 'Contenu non lu par le résumé : ouvrez le courriel depuis le contact.',
        }),
      h('div', { class: 'ref-foot' }, [
        where,
        src.kind === 'email' && p.where ? h('span', { text: 'le courriel est dans sa liste Courriels' }) : null,
      ]),
    ]);
  }

  /** One figure. A zero is drawn faint so the figures that matter stand out. */
  function kpi(o) {
    return h('div', { class: 'kpi k-' + o.kind + (o.zero ? ' is-zero' : '') + (o.alert ? ' is-alert' : '') }, [
      h('div', { class: 'kpi-icon', 'aria-hidden': 'true' }, icon(o.icon)),
      h('div', { class: 'kpi-text' }, [
        h('div', { class: 'kpi-label', text: o.label, title: o.label }),
        h('div', { class: 'kpi-value', text: o.value, title: o.value }),
        o.sub || o.alertSub ? h('div', { class: 'kpi-sub' }, [
          o.sub || null,
          o.sub && o.alertSub ? ' · ' : null,
          o.alertSub ? h('span', { class: 'is-alert', text: o.alertSub }) : null,
        ]) : null,
      ]),
    ]);
  }

  function kpis(s) {
    var last = s.last_touch;
    var who = last && last.kind === 'email' ? (last.direction === 'in' ? ' du client' : ' par Affichez') : '';
    return h('div', { class: 'kpis' }, [
      kpi({
        label: 'Dernière activité', icon: 'clock', kind: 'slate', zero: !last,
        value: last ? capitalize(ago(last.date)) : 'Aucune',
        sub: last ? capitalize(KIND[last.kind] || '') + who : '18 derniers mois',
      }),
      kpi({ label: 'Courriels', icon: 'mail', kind: 'indigo', zero: !s.emails, value: String(s.emails), sub: '12 mois' }),
      kpi({ label: 'Notes', icon: 'note', kind: 'violet', zero: !s.notes, value: String(s.notes), sub: '12 mois' }),
      kpi({
        label: 'Facturé 12 mois', icon: 'dollar', kind: 'green', zero: !s.invoiced_12m, alert: !!s.overdue.count,
        value: money.format(s.invoiced_12m),
        sub: s.overdue.count ? null : 'avant taxes',
        alertSub: s.overdue.count ? plural(s.overdue.count, 'facture', 'factures') + ' en retard' : null,
      }),
      kpi({
        label: 'Devis ouverts', icon: 'quote', kind: 'blue', zero: !s.open_quotes.count,
        value: String(s.open_quotes.count),
        sub: s.open_quotes.count ? money.format(s.open_quotes.total) : null,
      }),
      kpi({ label: 'Tâches ouvertes', icon: 'task', kind: 'amber', zero: !s.open_tasks, value: String(s.open_tasks) }),
    ]);
  }

  /** What needs a rep's attention now, drawn above the figures. */
  function signals(s) {
    var out = [];
    if (s.waiting_on_us_days !== null && s.waiting_on_us_days !== undefined) {
      var d = s.waiting_on_us_days;
      out.push(h('span', { class: 'signal t-warn' }, [icon('clock'),
        'Le client attend notre réponse ' + (d === 0 ? 'depuis aujourd’hui' : 'depuis ' + plural(d, 'jour', 'jours'))]));
    }
    if (s.overdue && s.overdue.count) {
      out.push(h('span', { class: 'signal t-critical' }, [icon('alert'),
        plural(s.overdue.count, 'facture en retard', 'factures en retard') + ' · solde ' + money.format(s.overdue.total)]));
    }
    return out.length ? h('div', { class: 'signals' }, out) : null;
  }

  function basisText(b, months) {
    var parts = [];
    if (b.emails) parts.push(plural(b.emails, 'courriel', 'courriels'));
    if (b.notes) parts.push(plural(b.notes, 'note', 'notes'));
    if (b.meetings) parts.push(plural(b.meetings, 'rencontre', 'rencontres'));
    if (b.tasks) parts.push(plural(b.tasks, 'tâche', 'tâches'));
    if (b.quotes) parts.push(plural(b.quotes, 'devis', 'devis'));
    if (b.invoices) parts.push(plural(b.invoices, 'facture', 'factures'));
    if (!parts.length) return 'Aucune activité trouvée sur ' + months + ' mois.';
    var list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' et ' + parts[parts.length - 1] : parts[0];
    return 'Basé sur ' + list + ' (activité des ' + months + ' derniers mois, factures depuis le début).';
  }

  function progress(running) {
    var secs = running && running.created_at ? Math.max(0, Math.round((Date.now() - Date.parse(running.created_at)) / 1000)) : 0;
    return h('div', { class: 'running', role: 'status' }, [
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', { text: 'Lecture des courriels, notes, devis et factures, puis rédaction du résumé… ' + (secs ? secs + ' s' : '') }),
    ]);
  }

  function alertBox(text) {
    return h('div', { class: 'alert', role: 'alert' }, [icon('alert'), h('span', { text: text })]);
  }

  function header(r, summary, running) {
    var temp = TEMPERATURE[r.temperature] || { label: r.temperature, tone: 'idle', icon: 'info' };
    var updated = 'Mis à jour ' + ago(summary.created_at) + (summary.requested_by_name ? ' · ' + summary.requested_by_name : '');
    return h('div', { class: 'hero t-' + temp.tone }, [
      h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, icon(temp.icon)),
      h('div', { class: 'hero-text' }, [
        h('div', { class: 'hero-kicker', text: 'Température de la relation' }),
        h('div', { class: 'hero-title', text: temp.label }),
        r.temperature_reason ? h('p', { class: 'hero-reason', text: r.temperature_reason }) : null,
      ]),
      h('div', { class: 'hero-side' }, [
        h('span', { class: 'updated', text: updated }),
        h('button', { class: 'btn btn-outline', type: 'button', disabled: !!running, onclick: generate },
          running ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Génération…'] : [icon('refresh'), 'Régénérer']),
      ]),
    ]);
  }

  function keyPoints(r) {
    return h('ul', { class: 'list' }, r.key_points.map(function (p, i) {
      var t = POINT_TONE[p.tone] || POINT_TONE.neutre;
      return h('li', { class: 'point t-' + t.tone }, [
        h('span', { class: 'point-icon', role: 'img', 'aria-label': t.label, title: t.label }, icon(t.icon)),
        h('div', null, [
          h('div', { class: 'point-text', text: p.text }),
          sourceLinks(p.sources, r.sources, 'p' + i),
          refPreview(p.sources, r.sources, 'p' + i),
        ]),
      ]);
    }));
  }

  /** The task or quote a step acts on, as a link to it. */
  function targetChip(s) {
    var t = s.target;
    if (!t) return null;
    if (t.kind === 'task') {
      return h('button', { class: 'target', type: 'button', title: 'Ouvrir la tâche', onclick: openTask(t.record_id) }, [
        icon('task'), h('span', { class: 'target-text', text: '« ' + t.label + ' »' + (t.due ? ' · échéance ' + fmtDate(t.due) : '') }),
      ]);
    }
    return h('button', { class: 'target', type: 'button', title: 'Ouvrir le devis dans Zoho Books', onclick: openUrl(t.url) }, [
      icon('quote'), h('span', { class: 'target-text', text: 'Devis ' + t.label + ' · ' + money.format(t.total) }),
    ]);
  }

  function dueTag(s, prefix) {
    var due = stepDue(s);
    if (!due) return null;
    return due === today() ? tag('calendar', prefix + 'aujourd’hui', 't-warn') : tag('calendar', prefix + fmtDate(due));
  }

  function stepButtons(s, i, summary) {
    var key = summary.id + ':' + i;
    var action = actionOf(s);
    var ui = ACTION[action];
    var done = state.doneSteps[key];
    if (done) {
      return h('button', { class: 'btn btn-sm btn-done', type: 'button', title: 'Ouvrir', onclick: done.open }, [icon('check'), done.label]);
    }
    if (state.busySteps[key]) {
      return h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: true }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), ui.busy]);
    }
    if (state.confirming === key) {
      return h('div', { class: 'step-confirm' }, [
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: cancelConfirm }, 'Annuler'),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: function () { act(s, i, summary); } }, [icon(ui.icon), ui.confirm]),
      ]);
    }
    var cls = action === 'revise_quote' ? 'btn btn-sm btn-outline' : 'btn btn-sm btn-primary';
    return h('button', { class: cls, type: 'button', onclick: function () { act(s, i, summary); } }, [icon(ui.icon), ui.button]);
  }

  function nextSteps(r, summary) {
    if (!r.next_steps.length) return h('p', { class: 'empty-note', text: 'Aucune action suggérée pour l’instant.' });
    return h('ol', { class: 'list steps' }, r.next_steps.map(function (s, i) {
      var action = actionOf(s);
      var done = !!state.doneSteps[summary.id + ':' + i];
      return h('li', { class: 'step' + (done ? ' is-done' : '') }, [
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, done ? icon('check') : String(i + 1)),
        h('div', null, [
          h('div', { class: 'step-title', text: s.title }),
          s.reason ? h('p', { class: 'step-reason', text: s.reason }) : null,
          h('div', { class: 'step-meta' }, [
            targetChip(s),
            action === 'create_task' ? dueTag(s, 'Échéance ') : null,
            action === 'update_task' ? dueTag(s, 'Nouvelle échéance ') : null,
            action === 'update_task' && s.new_subject ? tag('task', 'Nouveau titre : ' + s.new_subject) : null,
            s.contact_name ? tag('user', s.contact_name) : null,
          ]),
          h('div', { class: 'step-foot' }, [sourceLinks(s.sources, r.sources, 's' + i) || h('span'), stepButtons(s, i, summary)]),
          refPreview(s.sources, r.sources, 's' + i),
        ]),
      ]);
    }));
  }

  function panel(title, count, content) {
    return h('section', null, [
      h('div', { class: 'panel-head' }, [h('h3', { class: 'panel-title', text: title }), h('span', { class: 'count', text: String(count) })]),
      content,
    ]);
  }

  function renderSummary(summary, running) {
    var r = summary.result;
    return h('div', { class: 'card' + (running ? ' is-busy' : '') }, [
      header(r, summary, running),
      running ? progress(running) : null,
      h('div', { class: 'body' }, [
        signals(r.stats),
        kpis(r.stats),
        h('section', { class: 'synth' }, [
          h('div', { class: 'synth-head' }, [icon('sparkle'), 'Synthèse']),
          h('p', { class: 'synth-text', text: r.summary }),
        ]),
        h('div', { class: 'cols' }, [
          panel('Points clés', r.key_points.length, keyPoints(r)),
          panel('Prochaines étapes', r.next_steps.length, nextSteps(r, summary)),
        ]),
        r.warnings && r.warnings.length
          ? h('div', { class: 'notice' }, [icon('info'), h('span', { text: 'Données incomplètes : ' + r.warnings.join(' ') })])
          : null,
      ]),
      state.error ? alertBox(state.error) : null,
      h('div', { class: 'foot' }, [
        h('span', { text: basisText(r.basis, r.window_months) }),
        h('span', { class: 'foot-ai' }, [icon('sparkle'), 'Rédigé par IA · vérifiez les sources']),
      ]),
    ]);
  }

  var TABS = [['synth', 'Synthèse'], ['points', 'Points clés'], ['steps', 'Prochaines étapes']];

  function tabBar(r) {
    var counts = { points: r.key_points.length, steps: r.next_steps.length };
    return h('div', { class: 'tabs', role: 'tablist' }, TABS.map(function (t) {
      var on = state.tab === t[0];
      return h('button', {
        class: 'tab' + (on ? ' is-on' : ''), type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        onclick: function () { state.tab = t[0]; render(); },
      }, [t[1], counts[t[0]] !== undefined ? h('span', { class: 'count', text: String(counts[t[0]]) }) : null]);
    }));
  }

  function synthesisPanel(r) {
    return h('div', { class: 'synth-panel' }, [
      h('p', { class: 'synth-text', text: r.summary }),
      r.warnings && r.warnings.length
        ? h('div', { class: 'notice' }, [icon('info'), h('span', { text: 'Données incomplètes : ' + r.warnings.join(' ') })])
        : null,
      h('div', { class: 'foot' }, [
        h('span', { text: basisText(r.basis, r.window_months) }),
        h('span', { class: 'foot-ai' }, [icon('sparkle'), 'Rédigé par IA · vérifiez les sources']),
      ]),
    ]);
  }

  /** The same card in 500 px: header, alerts and figures, then one panel at a time. */
  function renderCompact(summary, running) {
    var r = summary.result;
    var panel = state.tab === 'points' ? keyPoints(r)
      : state.tab === 'steps' ? nextSteps(r, summary)
      : synthesisPanel(r);
    return h('div', { class: 'card' + (running ? ' is-busy' : '') }, [
      header(r, summary, running),
      running ? progress(running) : null,
      state.error ? alertBox(state.error) : null,
      h('div', { class: 'body' }, [
        signals(r.stats),
        kpis(r.stats),
        tabBar(r),
        h('div', { class: 'tab-panel', role: 'tabpanel', 'data-tab': state.tab }, panel),
      ]),
    ]);
  }

  var READS = [['email', 'Courriels'], ['note', 'Notes'], ['meeting', 'Rencontres'], ['task', 'Tâches'], ['quote', 'Devis'], ['invoice', 'Factures']];

  function renderEmpty(running, failed) {
    var message = failed ? 'La dernière génération a échoué : ' + (failed.error || 'erreur inconnue') : state.error;
    return h('div', { class: 'card' }, [
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('sparkle')),
        h('div', { class: 'empty-title', text: running ? 'Rédaction du résumé…' : 'Aucun résumé pour ce compte' }),
        h('p', { class: 'empty-sub', text: 'Un résumé de la relation, rédigé à partir des 18 derniers mois d’activité du compte et de ses contacts.' }),
        running ? null : h('div', { class: 'empty-kinds' }, READS.map(function (k) { return tag(KIND_ICON[k[0]], k[1]); })),
        running ? progress(running) : h('button', { class: 'btn btn-primary', type: 'button', onclick: generate }, [icon('sparkle'), 'Générer le résumé']),
      ]),
      message ? alertBox(message) : null,
    ]);
  }

  function render() {
    var data = state.data;
    var view;
    if (!data && !state.error) {
      view = h('div', { class: 'card' }, [h('div', { class: 'loading' }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Chargement…'])]);
    } else if (data && data.summary && data.summary.result) {
      if (data.failed && !data.running && !state.error) state.error = 'La dernière régénération a échoué : ' + (data.failed.error || 'erreur inconnue');
      view = COMPACT ? renderCompact(data.summary, data.running) : renderSummary(data.summary, data.running);
    } else {
      view = renderEmpty(data && data.running, data && data.failed);
    }
    // A redraw keeps the tab panel where it was scrolled: a step's confirm button
    // takes the place of the one just clicked, often below the panel's first screen.
    var panel = root.querySelector('.tab-panel');
    var scroll = panel && panel.getAttribute('data-tab') === state.tab ? panel.scrollTop : 0;
    root.replaceChildren(view);
    panel = root.querySelector('.tab-panel');
    if (panel && scroll) panel.scrollTop = scroll;
    resize();
  }

  // ─── Start ──────────────────────────────────────────────────────────────────

  function start() {
    sdkReady = true;
    render();
    if (!/^\d+$/.test(state.accountId)) {
      state.error = 'Ce widget s’affiche sur la fiche d’un compte.';
      render();
      return;
    }
    load();
  }

  /** The top card while piloted: shown to the listed profiles only. */
  function inPilot(user) {
    if (!COMPACT || !PILOT_PROFILES.length) return true;
    var profile = user && user.profile && (user.profile.name || user.profile);
    return PILOT_PROFILES.indexOf(profile) >= 0;
  }

  ZOHO.embeddedApp.on('PageLoad', function (page) {
    var id = page && page.EntityId;
    state.accountId = String(Array.isArray(id) ? id[0] : id || '');
    var user = ZOHO.CRM.CONFIG.getCurrentUser()
      .then(function (res) {
        var u = res && res.users && res.users[0];
        if (u) state.user = { id: u.id, name: u.full_name, email: u.email };
        return u || null;
      })
      .catch(function () { return null; });   // the user is only recorded, never required
    if (!COMPACT || !PILOT_PROFILES.length) {
      start();
      return;
    }
    // Outside the pilot nothing is drawn and no height is asked: the slot stays hidden.
    user.then(function (u) { if (inPilot(u)) start(); });
  });

  ZOHO.embeddedApp.init();
})();
