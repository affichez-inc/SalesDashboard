// Résumé IA — related-list widget on the Zoho CRM Account page.
//
// Reads and generates summaries through the account-summary edge function. The
// call goes through a Zoho Connection, which adds the API key on Zoho's side.

(function () {
  'use strict';

  var CONNECTION = 'affichez_resume_ia';
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
    call: 'appel', meeting: 'rencontre', quote: 'devis', invoice: 'facture',
  };
  var KIND_ICON = {
    account: 'building', contact: 'user', email: 'mail', note: 'note', task: 'task',
    call: 'phone', meeting: 'calendar', quote: 'quote', invoice: 'dollar',
  };

  var state = {
    accountId: '',
    accountName: '',
    user: null,
    data: null,          // { summary, running, failed } from the function
    error: null,         // message of the last failed call
    pollStarted: 0,
    pollTimer: null,
    pollFailures: 0,
    createdTasks: {},    // "<summary id>:<step index>" → task id, for this page view
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
    phone: svg('<path d="M5 4h3.5l2 5-2.4 1.5a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
    note: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
    task: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    quote: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>'),
    dollar: svg('<path d="M12 2.5v19M16.5 6.5C15.7 5 14 4.3 12 4.3c-2.7 0-4.5 1.3-4.5 3.3 0 4.8 9 2.4 9 7.2 0 2.1-2 3.4-4.5 3.4-2.3 0-4-.9-4.8-2.4"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'),
    building: svg('<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3"/>'),
    link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
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
   * Fits the frame to the card. Measured on the card, not the body: the body is
   * at least as tall as the frame, so it could never shrink.
   */
  function resize() {
    var height = Math.ceil(root.getBoundingClientRect().height) + 4;
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    try {
      ZOHO.CRM.UI.Resize({ height: String(height), width: String(document.documentElement.clientWidth) });
    } catch (e) { /* not in a resizable location */ }
  }

  // The card's height changes after a render too: the web font loading, text
  // re-wrapping when Zoho resizes the frame's width.
  if (window.ResizeObserver) new ResizeObserver(resize).observe(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resize);

  // ─── Backend ────────────────────────────────────────────────────────────────

  function errorText(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return obj.error || obj.message || obj.msg || (obj.code && obj.code !== 'SUCCESS' ? String(obj.code) : null);
  }

  /**
   * The Connection wraps the remote answer; find the function's JSON in it.
   * Anything that is not a { summary, running, failed } answer is an error,
   * so a gateway or Zoho error page never replaces the card's data.
   */
  function unwrap(res) {
    var d = res && res.details;
    var body = d && d.statusMessage !== undefined ? d.statusMessage
      : d && d.response !== undefined ? d.response
      : d && d.output !== undefined ? d.output
      : d !== undefined ? d : res;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { throw new Error('Réponse illisible du service de résumé.'); }
    }
    if (body && typeof body === 'object' && !body.error && ('summary' in body || 'running' in body || 'failed' in body)) {
      return { summary: body.summary || null, running: body.running || null, failed: body.failed || null };
    }
    throw new Error(errorText(body) || errorText(res) || 'Réponse inattendue du service de résumé.');
  }

  function call(payload) {
    return ZOHO.CRM.CONNECTION.invoke(CONNECTION, {
      url: ENDPOINT,
      method: 'POST',
      param_type: 2,
      parameters: payload,
      headers: { 'Content-Type': 'application/json' },
    }).then(function (res) {
      if (window.console && console.debug) console.debug('[ResumeIA]', res);
      return unwrap(res);
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

  function createTask(step, key, button) {
    button.disabled = true;
    button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Création…');
    var data = {
      Subject: step.title,
      Due_Date: stepDue(step),
      What_Id: state.accountId,
      $se_module: 'Accounts',
      Description: 'Créée depuis le résumé IA du compte.',
    };
    if (step.contact_id) data.Who_Id = step.contact_id;
    ZOHO.CRM.API.insertRecord({ Entity: 'Tasks', APIData: data, Trigger: ['workflow'] })
      .then(function (res) {
        var row = res && res.data && res.data[0];
        if (!row || row.code !== 'SUCCESS') throw new Error((row && row.message) || 'Création refusée.');
        state.createdTasks[key] = row.details && row.details.id;
        render();
      })
      .catch(function (err) {
        button.disabled = false;
        button.replaceChildren(icon('plus'), 'Créer la tâche');
        state.error = 'Tâche non créée : ' + (err && err.message ? err.message : String(err));
        render();
      });
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function tag(iconName, text, extra) {
    return h('span', { class: 'tag' + (extra ? ' ' + extra : '') }, [icon(iconName), text]);
  }

  function sourceLinks(ids, sources) {
    var refs = (ids || []).map(function (id) { return sources && sources[id]; }).filter(Boolean);
    if (!refs.length) return null;
    return h('div', { class: 'srcs' }, refs.map(function (src) {
      var label = (KIND[src.kind] || 'source') + (src.date ? ' · ' + fmtDate(src.date) : '');
      return h('button', { class: 'src', type: 'button', title: 'Ouvrir : ' + label, onclick: function () { openSource(src); } },
        [icon(KIND_ICON[src.kind] || 'link'), label]);
    }));
  }

  /** One figure. A zero is drawn faint so the figures that matter stand out. */
  function kpi(o) {
    return h('div', { class: 'kpi k-' + o.kind + (o.deal ? ' is-deal' : '') + (o.zero ? ' is-zero' : '') + (o.alert ? ' is-alert' : '') }, [
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
    var who = last && (last.kind === 'email' || last.kind === 'call') ? (last.direction === 'in' ? ' du client' : ' par Affichez') : '';
    return h('div', { class: 'kpis' }, [
      kpi({
        label: 'Dernière activité', icon: 'clock', kind: 'slate', zero: !last,
        value: last ? capitalize(ago(last.date)) : 'Aucune',
        sub: last ? capitalize(KIND[last.kind] || '') + who : '18 derniers mois',
      }),
      kpi({ label: 'Courriels', icon: 'mail', kind: 'indigo', zero: !s.emails, value: String(s.emails), sub: '12 mois' }),
      kpi({
        label: 'Appels', icon: 'phone', kind: 'teal', zero: !s.calls && !s.missed_calls,
        value: String(s.calls), sub: s.calls ? s.call_minutes + ' min' : '12 mois',
        alertSub: s.missed_calls ? plural(s.missed_calls, 'manqué', 'manqués') : null,
      }),
      kpi({ label: 'Notes', icon: 'note', kind: 'violet', zero: !s.notes, value: String(s.notes), sub: '12 mois' }),
      kpi({
        label: 'Facturé 12 mois', icon: 'dollar', kind: 'green', deal: true, zero: !s.invoiced_12m, alert: !!s.overdue.count,
        value: money.format(s.invoiced_12m),
        sub: s.overdue.count ? null : 'avant taxes',
        alertSub: s.overdue.count ? plural(s.overdue.count, 'facture', 'factures') + ' en retard' : null,
      }),
      kpi({
        label: 'Devis ouverts', icon: 'quote', kind: 'blue', deal: true, zero: !s.open_quotes.count,
        value: String(s.open_quotes.count),
        sub: s.open_quotes.count ? money.format(s.open_quotes.total) : null,
      }),
      kpi({ label: 'Tâches ouvertes', icon: 'task', kind: 'amber', deal: true, zero: !s.open_tasks, value: String(s.open_tasks) }),
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
    if (b.calls) parts.push(plural(b.calls, 'appel', 'appels'));
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
      h('span', { text: 'Lecture des courriels, notes, appels, devis et factures, puis rédaction du résumé… ' + (secs ? secs + ' s' : '') }),
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
    return h('ul', { class: 'list' }, r.key_points.map(function (p) {
      var t = POINT_TONE[p.tone] || POINT_TONE.neutre;
      return h('li', { class: 'point t-' + t.tone }, [
        h('span', { class: 'point-icon', role: 'img', 'aria-label': t.label, title: t.label }, icon(t.icon)),
        h('div', null, [h('div', { class: 'point-text', text: p.text }), sourceLinks(p.sources, r.sources)]),
      ]);
    }));
  }

  function nextSteps(r, summary) {
    if (!r.next_steps.length) return h('p', { class: 'empty-note', text: 'Aucune action suggérée pour l’instant.' });
    return h('ol', { class: 'list steps' }, r.next_steps.map(function (s, i) {
      var key = summary.id + ':' + i;
      var taskId = state.createdTasks[key];
      var due = stepDue(s);
      var button = taskId
        ? h('button', { class: 'btn btn-sm btn-done', type: 'button', title: 'Ouvrir la tâche', onclick: function () { openSource({ module: 'Tasks', record_id: taskId }); } }, [icon('check'), 'Tâche créée'])
        : h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, [icon('plus'), 'Créer la tâche']);
      if (!taskId) button.addEventListener('click', function () { createTask(s, key, button); });
      return h('li', { class: 'step' + (taskId ? ' is-done' : '') }, [
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, taskId ? icon('check') : String(i + 1)),
        h('div', null, [
          h('div', { class: 'step-title', text: s.title }),
          h('div', { class: 'step-meta' }, [
            due === today() ? tag('calendar', 'Aujourd’hui', 't-warn') : tag('calendar', 'Échéance ' + fmtDate(due)),
            s.contact_name ? tag('user', s.contact_name) : null,
          ]),
          h('div', { class: 'step-foot' }, [sourceLinks(s.sources, r.sources) || h('span'), button]),
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

  var READS = [['email', 'Courriels'], ['note', 'Notes'], ['call', 'Appels'], ['meeting', 'Rencontres'], ['task', 'Tâches'], ['quote', 'Devis'], ['invoice', 'Factures']];

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
      view = renderSummary(data.summary, data.running);
    } else {
      view = renderEmpty(data && data.running, data && data.failed);
    }
    root.replaceChildren(view);
    resize();
  }

  // ─── Start ──────────────────────────────────────────────────────────────────

  ZOHO.embeddedApp.on('PageLoad', function (page) {
    var id = page && page.EntityId;
    state.accountId = String(Array.isArray(id) ? id[0] : id || '');
    render();
    ZOHO.CRM.CONFIG.getCurrentUser()
      .then(function (res) {
        var u = res && res.users && res.users[0];
        if (u) state.user = { id: u.id, name: u.full_name, email: u.email };
      })
      .catch(function () { /* the user is only recorded, never required */ });
    if (!/^\d+$/.test(state.accountId)) {
      state.error = 'Ce widget s’affiche sur la fiche d’un compte.';
      render();
      return;
    }
    load();
  });

  ZOHO.embeddedApp.init();
})();
