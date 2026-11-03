'use strict';

// A bio is a one-liner shown on profile cards, not a place for pasted text. Keep in step with BIO_MAX in web/js/utils.js.
const BIO_MAX = 200;

const clipBio = (value) => Array.from(String(value)).slice(0, BIO_MAX).join('');

module.exports = { BIO_MAX, clipBio };
