'use strict';

class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

module.exports = { AiError };
