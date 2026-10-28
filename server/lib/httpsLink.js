'use strict';

const httpsLink = (v) => (typeof v === 'string' && /^https:\/\/\S+$/i.test(v.trim()) ? v.trim() : '');

module.exports = { httpsLink };
