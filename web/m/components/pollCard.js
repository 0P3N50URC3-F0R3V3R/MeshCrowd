import { api } from '../../js/api.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast } from '../../js/utils.js';
import { handleError } from '../lib/errors.js';
import { openSheet } from './bottomSheet.js';

export function pollHtml(poll, meId) {
  const total = poll.options.reduce((n, o) => n + o.voterIds.length, 0) || 1;
  return `<div class="m-poll" data-poll="${poll.id}">${poll.options.map((o) => {
    const mine = o.voterIds.includes(meId);
    const pct = Math.round((o.voterIds.length / total) * 100);
    return `<button class="m-poll-opt${mine ? ' mine' : ''}" data-vote="${o.id}" data-mine="${mine ? 1 : 0}">
      <span class="m-poll-bar" style="width:${pct}%"></span>
      <span class="m-poll-label">${escapeHtml(o.label)}</span><span class="m-poll-count">${o.voterIds.length}</span></button>`;
  }).join('')}<div class="m-poll-foot">${t('m.pollVotes', { n: poll.totalVoters })}</div></div>`;
}

export function onPollClick(target, msg) {
  const btn = target.closest('[data-vote]');
  if (!btn || !msg.poll) return false;
  const optionId = Number(btn.dataset.vote);
  const call = btn.dataset.mine === '1' ? api.unvotePoll(msg.poll.id, optionId) : api.votePoll(msg.poll.id, optionId);
  call.catch((err) => handleError(err));
  return true;
}

export function openPollSheet(ctx) {
  openSheet({
    title: t('m.attachPoll'),
    html: `<input class="m-input" id="p-q" maxlength="300" placeholder="${t('m.pollQuestionPh')}">
      <div id="p-opts" class="m-poll-form">${[1, 2].map((n) => `<input class="m-input p-opt" maxlength="100" placeholder="${t('m.pollOptionPh', { n })}">`).join('')}</div>
      <button class="btn btn-secondary" id="p-add" style="margin-top:8px">${t('m.pollAddOption')}</button>
      <label class="m-check"><input type="checkbox" id="p-multi"> ${t('m.pollMulti')}</label>
      <button class="btn btn-primary btn-block" id="p-go">${t('m.pollCreate')}</button>`,
    onMount: (body, close) => {
      const opts = body.querySelector('#p-opts');
      body.querySelector('#p-add').addEventListener('click', () => {
        const n = opts.children.length + 1;
        if (n > 10) return;
        opts.insertAdjacentHTML('beforeend', `<input class="m-input p-opt" maxlength="100" placeholder="${t('m.pollOptionPh', { n })}">`);
      });
      body.querySelector('#p-go').addEventListener('click', async () => {
        const question = body.querySelector('#p-q').value.trim();
        const options = [...body.querySelectorAll('.p-opt')].map((i) => i.value.trim()).filter(Boolean);
        if (!question || options.length < 2) return toast(t('m.pollNeedOptions'), { type: 'error' });
        try {
          await api.createPoll({ scopeType: ctx.scopeType, scopeId: ctx.scopeId, question, options, multiSelect: body.querySelector('#p-multi').checked });
          close();
        } catch (err) { handleError(err); }
      });
    },
  });
}
