/**
 * ANVESA UI — Project settings (.anvesa/config.json)
 *
 * Reads the settings with GET /api/config and saves only what changed with PUT /api/config, naming
 * the revision it read: the server refuses the change if the file moved on since, so an edit made
 * elsewhere is never undone from here.
 */

import { escapeHtml } from './search.js';

const FAMILY_LABELS = {
  'anvesa-code': 'anvesa code models',
  open: 'open models',
  custom: 'brought in by you',
};

export function initSettings(api) {
  const byId = (id) => document.getElementById(id);
  const form = byId('settingsForm');
  const message = byId('settingsMessage');
  if (!form) return { load: async () => undefined };

  /** What was read, to send only what changed. */
  let current = null;

  function say(text, kind = 'info') {
    message.hidden = !text;
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function render(data) {
    current = data;
    byId('settingsPath').textContent = data.path;
    const raw = data.raw ?? {};

    const select = byId('settingsModel');
    const chosen = typeof raw.model === 'string' ? raw.model : '';
    const groups = {};
    for (const model of data.models) (groups[model.family] ??= []).push(model);
    select.innerHTML = [
      `<option value="">The tier this machine suits (no model set)</option>`,
      ...Object.entries(groups).map(
        ([family, models]) =>
          `<optgroup label="${escapeHtml(FAMILY_LABELS[family] ?? family)}">${models
            .map(
              (m) =>
                `<option value="${escapeHtml(m.id)}"${m.id === chosen ? ' selected' : ''}>${escapeHtml(
                  `${m.id}  ·  ${m.sizeMb} MB  ·  ${m.license}${m.installed ? '' : '  ·  not installed'}`,
                )}</option>`,
            )
            .join('')}</optgroup>`,
      ),
    ].join('');
    // A model named in the file but no longer known still shows, so saving does not drop it.
    if (chosen && !data.models.some((m) => m.id === chosen)) {
      select.insertAdjacentHTML(
        'beforeend',
        `<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)} (unknown)</option>`,
      );
    }

    byId('settingsChannels').innerHTML = data.channels
      .map(
        (c) => `<tr data-channel="${escapeHtml(c.name)}">
          <td><code>${escapeHtml(c.name)}</code>${c.builtin ? ' <span class="badge badge-indigo">built in</span>' : ''}</td>
          <td><input type="checkbox" data-field="enabled"${c.enabled ? ' checked' : ''} aria-label="${escapeHtml(c.name)} on"></td>
          <td><input type="number" data-field="weight" min="0" step="0.05" value="${escapeHtml(String(c.weight))}" aria-label="${escapeHtml(c.name)} weight"></td>
        </tr>`,
      )
      .join('');

    const fusion = raw.fusion && typeof raw.fusion === 'object' ? raw.fusion : {};
    byId('settingsFusionK').value = fusion.k ?? '';

    const indexing = raw.indexing && typeof raw.indexing === 'object' ? raw.indexing : {};
    byId('settingsIgnore').value = Array.isArray(indexing.ignore) ? indexing.ignore.join('\n') : '';

    const telemetry = raw.telemetry;
    byId('settingsTelemetryOff').checked =
      telemetry === false || (typeof telemetry === 'object' && telemetry?.enabled === false);
    byId('settingsTelemetryQuiet').checked =
      typeof telemetry === 'object' && telemetry?.show_notice === false;
  }

  /** The form against what was read: only the settings that differ. */
  function edits() {
    const before = current;
    const raw = before.raw ?? {};
    const out = {};

    const model = byId('settingsModel').value;
    if (model !== (typeof raw.model === 'string' ? raw.model : '')) out.model = model || null;

    const channels = {};
    for (const row of byId('settingsChannels').querySelectorAll('tr[data-channel]')) {
      const name = row.dataset.channel;
      const was = before.channels.find((c) => c.name === name);
      const enabled = row.querySelector('[data-field="enabled"]').checked;
      const weight = Number(row.querySelector('[data-field="weight"]').value);
      const change = {};
      if (enabled !== was.enabled) change.enabled = enabled;
      if (Number.isFinite(weight) && weight !== was.weight) change.weight = weight;
      if (Object.keys(change).length) channels[name] = change;
    }
    if (Object.keys(channels).length) out.channels = channels;

    const fusion = raw.fusion && typeof raw.fusion === 'object' ? raw.fusion : {};
    const k = byId('settingsFusionK').value.trim();
    if (k !== String(fusion.k ?? '')) out.fusionK = k === '' ? null : Number(k);

    const indexing = raw.indexing && typeof raw.indexing === 'object' ? raw.indexing : {};
    const ignore = byId('settingsIgnore')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const had = Array.isArray(indexing.ignore) ? indexing.ignore : [];
    if (JSON.stringify(ignore) !== JSON.stringify(had)) out.ignore = ignore;

    const telemetry = raw.telemetry;
    const wasOff =
      telemetry === false || (typeof telemetry === 'object' && telemetry?.enabled === false);
    const wasQuiet = typeof telemetry === 'object' && telemetry?.show_notice === false;
    const off = byId('settingsTelemetryOff').checked;
    const quiet = byId('settingsTelemetryQuiet').checked;
    if (off !== wasOff || quiet !== wasQuiet) {
      out.telemetry = {
        ...(off !== wasOff ? { enabled: !off } : {}),
        ...(quiet !== wasQuiet ? { show_notice: !quiet } : {}),
      };
    }
    return out;
  }

  async function load() {
    try {
      const resp = await api.getConfig();
      if (!resp?.success) {
        say(resp?.error || resp?.message || 'The settings could not be read.', 'error');
        return;
      }
      render(resp);
      say('');
    } catch (err) {
      say(`The settings could not be read: ${err}`, 'error');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current) return;
    const changes = edits();
    if (Object.keys(changes).length === 0) {
      say('Nothing changed.');
      return;
    }
    const button = byId('btnSaveSettings');
    button.disabled = true;
    try {
      const resp = await api.putConfig({ revision: current.revision, edits: changes });
      if (!resp?.success) {
        say(resp?.error || 'The settings were not saved.', 'error');
        return;
      }
      render(resp);
      const saved = `Saved: ${resp.changed.join(', ') || 'no change in the file'}.`;
      say(
        resp.reindex.length
          ? `${saved} Run anvesa index for the index to reflect ${resp.reindex.join(', ')}.`
          : saved,
        resp.reindex.length ? 'warn' : 'ok',
      );
    } catch (err) {
      say(`The settings were not saved: ${err}`, 'error');
    } finally {
      button.disabled = false;
    }
  });

  byId('btnReloadSettings')?.addEventListener('click', () => void load());

  return { load };
}
