import { api } from '../../js/api.js';
import { state, setDms } from '../../js/state.js';
import { nav } from '../router.js';
import { handleError } from './errors.js';

export async function openDmWith(userId) {
  try {
    const { dmId } = await api.openDm(userId);
    if (!state.dms.some((d) => d.id === dmId)) setDms((await api.listDms()).dms);
    nav.push('chat', { kind: 'dm', dmId });
  } catch (err) { handleError(err); }
}
