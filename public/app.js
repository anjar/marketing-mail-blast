// Minimal vanilla-JS frontend. It is only a representation of server state — it
// NEVER enforces the single-active-campaign invariant itself (the server + DB do).
// No framework, no build, no polling/SSE/WebSocket. Refresh is manual.

(function () {
  'use strict';

  var form = document.getElementById('campaign-form');
  var subject = document.getElementById('subject');
  var body = document.getElementById('body');
  var sendBtn = document.getElementById('send');
  var banner = document.getElementById('banner');
  var formError = document.getElementById('form-error');
  var progressEl = document.getElementById('progress');
  var refreshBtn = document.getElementById('refresh');

  var activeCampaignId = null;

  function setFormEnabled(enabled) {
    subject.disabled = !enabled;
    body.disabled = !enabled;
    sendBtn.disabled = !enabled;
    banner.classList.toggle('hidden', enabled);
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.classList.toggle('hidden', !msg);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function reasonRows(obj) {
    var keys = Object.keys(obj || {});
    if (keys.length === 0) return '<span class="muted">none</span>';
    return keys
      .map(function (k) {
        return '<li>' + esc(k) + ': <strong>' + esc(obj[k]) + '</strong></li>';
      })
      .join('');
  }

  function renderProgress(p) {
    if (!p) {
      progressEl.innerHTML = '<p class="muted">No active campaign.</p>';
      return;
    }
    progressEl.innerHTML =
      '<table class="kv">' +
      '<tr><td>Status</td><td><strong>' + esc(p.status) + '</strong></td></tr>' +
      '<tr><td>Total</td><td>' + esc(p.total) + '</td></tr>' +
      '<tr><td>Pending</td><td>' + esc(p.pending) + '</td></tr>' +
      '<tr><td>Sent</td><td>' + esc(p.sent) + '</td></tr>' +
      '<tr><td>Rejected</td><td>' + esc(p.rejected) + '</td></tr>' +
      '<tr><td>Failed</td><td>' + esc(p.failed) + '</td></tr>' +
      '<tr><td>Delivery unknown</td><td>' + esc(p.deliveryUnknown) + '</td></tr>' +
      '<tr><td>Delivery attempts</td><td>' + esc(p.totalDeliveryAttempts) + '</td></tr>' +
      '<tr><td>Started</td><td>' + esc(p.startedAt) + '</td></tr>' +
      '<tr><td>Completed</td><td>' + esc(p.completedAt || '—') + '</td></tr>' +
      '</table>' +
      '<h3>Rejected by reason</h3><ul>' + reasonRows(p.rejectedByReason) + '</ul>' +
      '<h3>Failed by reason</h3><ul>' + reasonRows(p.failedByReason) + '</ul>';
  }

  function isTerminal(status) {
    return status === 'COMPLETED' || status === 'COMPLETED_WITH_ISSUES' || status === 'FAILED';
  }

  function loadActive() {
    return fetch('/api/campaigns/active')
      .then(function (res) {
        if (res.status === 204) return null;
        return res.json();
      })
      .then(function (summary) {
        if (summary && !isTerminal(summary.status)) {
          activeCampaignId = summary.id;
          setFormEnabled(false);
          return refreshProgress();
        }
        activeCampaignId = summary ? summary.id : null;
        setFormEnabled(true);
        if (activeCampaignId) return refreshProgress();
        renderProgress(null);
      })
      .catch(function () {
        setFormEnabled(true);
      });
  }

  function refreshProgress() {
    if (!activeCampaignId) {
      renderProgress(null);
      return Promise.resolve();
    }
    return fetch('/api/campaigns/' + encodeURIComponent(activeCampaignId) + '/progress')
      .then(function (res) {
        if (!res.ok) throw new Error('progress unavailable');
        return res.json();
      })
      .then(function (p) {
        renderProgress(p);
        // When the campaign has finished, re-enable the form (US5).
        if (isTerminal(p.status)) {
          setFormEnabled(true);
        }
      })
      .catch(function () {});
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    sendBtn.disabled = true;
    fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: subject.value, body: body.value }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 201) {
          activeCampaignId = r.data.id;
          setFormEnabled(false);
          return refreshProgress();
        }
        if (r.status === 409) {
          showError('Another campaign is already active.');
          return loadActive();
        }
        showError((r.data && r.data.message) || 'Submission failed.');
        sendBtn.disabled = false;
      })
      .catch(function () {
        showError('Network error.');
        sendBtn.disabled = false;
      });
  });

  refreshBtn.addEventListener('click', function () {
    if (activeCampaignId) refreshProgress();
    else loadActive();
  });

  // On page load, request the current active campaign (FR requirement).
  loadActive();
})();
