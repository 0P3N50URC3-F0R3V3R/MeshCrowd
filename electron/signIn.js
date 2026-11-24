'use strict';

const COOKIE_NAME = 'dismesh_session';

const shouldAsk = (entry, hasCookie) => !!entry && entry.signIn === null && !!hasCookie;

const needsSessionConversion = (entry, cookie) => !!entry && entry.signIn === 'session' && !!cookie && cookie.session === false;

const sessionOrigins = (list) => list.filter((e) => e.signIn === 'session').map((e) => e.url);

module.exports = { COOKIE_NAME, shouldAsk, needsSessionConversion, sessionOrigins };
