import { api } from '../api.js';
import { icons } from '../icons.js';
import { apiErrorMessage, toast, escapeHtml } from '../utils.js';
import { t, currentLanguage, setPreLoginLanguage } from '../i18n.js';
import { generateSeed, deriveKeys, MIN_PASSWORD_LENGTH } from '../e2ee/crypto.mjs';
import { ensureIdentity, cacheSeed } from '../e2ee/identity.js';
import { parseInviteHash } from '../inviteHash.mjs';
import { createCaptcha, captchaErrorMessage } from '../captcha.js';
import { proveWith, passportBundle, readFileWithPassphrase, prepareLogin, splitCredential, wrapFor } from '../passport/flow.js';

const PASSPORT_FILE_ERROR = /unsupported passport file|wrong passphrase|does not match|no passport file/;

// Accepts a bare code or a pasted invite link (https://host/i/<code>, mcr://host/<code>).
function inviteCodeFrom(raw) {
  const v = String(raw || '').trim();
  const m = /^(?:https?|mcr):\/\/[^/]+\/(?:i\/)?([^/?#]+)/i.exec(v);
  try { return m ? decodeURIComponent(m[1]) : v; } catch { return v; }
}

// Renders the login/register screen into `root` and resolves with the logged-in user
// once auth succeeds. Single page, toggled between login/register/totp (the 2FA challenge step).
export function renderAuth(root) {
  return new Promise((resolve) => {
    let mode = 'login';
    let pendingToken = null;
    let languages = [];
    api.getLanguages().then((res) => { languages = res.languages; if (mode === 'login' || mode === 'register') render(); }).catch(() => {});
    let website = '';
    let regMode = 'open';
    const hashInvite = parseInviteHash(location.hash) || '';
    api.config().then((c) => {
      website = c.downloads?.website || '';
      regMode = c.registrationMode || 'open';
      if (regMode === 'closed' && mode === 'register') mode = 'login';
      if (mode === 'login' || mode === 'register') render();
    }).catch(() => {});
    let pendingCred = null;
    let pendingSeed = null;
    let cap = null;

    function render() {
      root.innerHTML = `
        <div class="auth-screen">
          <div class="auth-blob b1"></div>
          <div class="auth-blob b2"></div>
          <div class="auth-card">
            <div class="auth-brand">
              <div class="mark">${icons.dismesh(24)}</div>
              <div class="name">MeshCrowd</div>
            </div>
            ${mode !== 'totp' && languages.length > 1 ? `
            <select class="input" id="auth-lang" style="align-self:flex-end;width:auto;margin-bottom:8px">
              ${languages.map((l) => `<option value="${l.code}" ${l.code === currentLanguage() ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>` : ''}
            ${mode === 'totp' ? renderTotpForm() : mode === 'passportLogin' ? renderPassportLoginForm() : mode === 'recover' ? renderRecoverForm() : renderCredentialsForm()}
            ${website && (mode === 'login' || mode === 'register') ? `<div class="auth-switch"><a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${t('serverRail.projectWebsiteLink')}</a></div>` : ''}
          </div>
        </div>`;

      cap = null;
      const capSlot = root.querySelector('#captcha-slot');
      if (capSlot) { cap = createCaptcha(mode === 'register' ? 'register' : 'login'); cap.mount(capSlot); }

      root.querySelector('#auth-lang')?.addEventListener('change', (e) => {
        setPreLoginLanguage(e.target.value);
        window.location.reload();
      });

      if (mode === 'totp') {
        root.querySelector('#auth-form').addEventListener('submit', onSubmitTotp);
        root.querySelector('#totp-back').addEventListener('click', (e) => { e.preventDefault(); mode = 'login'; pendingToken = null; pendingCred = null; pendingSeed = null; render(); });
        root.querySelector('#f-code').focus();
        return;
      }

      if (mode === 'passportLogin' || mode === 'recover') {
        root.querySelector('#auth-form').addEventListener('submit', mode === 'recover' ? onSubmitRecover : onSubmitPassportLogin);
        root.querySelector('#auth-back').addEventListener('click', (e) => { e.preventDefault(); mode = 'login'; render(); });
        return;
      }
      root.querySelector('#auth-passport-login')?.addEventListener('click', (e) => { e.preventDefault(); mode = 'passportLogin'; render(); });
      root.querySelector('#auth-forgot')?.addEventListener('click', (e) => { e.preventDefault(); mode = 'recover'; render(); });
      root.querySelector('#auth-toggle')?.addEventListener('click', (e) => {
        e.preventDefault();
        mode = mode === 'login' ? 'register' : 'login';
        render();
      });
      root.querySelector('#auth-form').addEventListener('submit', onSubmit);
    }

    function renderCredentialsForm() {
      return `
        <h1>${mode === 'login' ? t('auth.welcomeBack') : t('auth.createAccount')}</h1>
        <p class="sub">${mode === 'login' ? t('auth.welcomeBackSub') : t('auth.createAccountSub')}</p>
        <form id="auth-form" novalidate>
          ${mode === 'register' && regMode === 'invite' ? `
            <div class="field">
              <label for="f-invite">${t('auth.inviteCodeLabel')}</label>
              <input class="input" id="f-invite" name="inviteCode" type="text" autocomplete="off" value="${escapeHtml(hashInvite)}" required>
              <div class="hint">${t('auth.inviteCodeHint')}</div>
            </div>` : ''}
          ${mode === 'register' ? `
            <div class="field">
              <label for="f-email">${t('auth.emailLabel')}</label>
              <input class="input" id="f-email" name="email" type="email" autocomplete="email" required>
            </div>` : ''}
          <div class="field">
            <label for="f-username">${mode === 'login' ? t('auth.loginIdentifierLabel') : t('auth.usernameLabel')}</label>
            <input class="input" id="f-username" name="username" type="text" autocomplete="username" required>
          </div>
          ${mode === 'register' ? `
            <div class="field">
              <label for="f-display">${t('auth.displayNameLabel')} <span class="hint">${t('auth.optional')}</span></label>
              <input class="input" id="f-display" name="displayName" type="text" autocomplete="nickname">
            </div>` : ''}
          <div class="field" style="margin-bottom:8px">
            <label for="f-password">${t('auth.passwordLabel')}</label>
            <input class="input" id="f-password" name="password" type="password"
              autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
          </div>
          ${mode === 'register' ? `
            <details class="passport-existing">
              <summary>${t('auth.useExistingPassport')}</summary>
              <div class="field"><label>${t('auth.passportFileLabel')}</label><input class="input" id="f-passport-file" type="file" accept=".mcpass,application/json"></div>
              <div class="field"><label>${t('auth.passportPassphraseLabel')}</label><input class="input" id="f-passport-pass" type="password" autocomplete="off"></div>
            </details>` : ''}
          <div id="captcha-slot"></div>
          <div class="error-text" id="auth-error"></div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">
            ${mode === 'login' ? t('auth.logIn') : t('auth.register')}
          </button>
          ${mode === 'login' ? `<div class="auth-switch"><a href="#" id="auth-passport-login">${t('auth.signInWithPassport')}</a> &middot; <a href="#" id="auth-forgot">${t('auth.forgotPassword')}</a></div>` : ''}
          ${mode === 'login' && regMode === 'closed' ? `<div class="auth-switch">${t('auth.registrationClosed')}</div>` : `<div class="auth-switch">
            ${mode === 'login' ? t('auth.needAccount') : t('auth.haveAccount')}
            <a href="#" id="auth-toggle">${mode === 'login' ? t('auth.register') : t('auth.logIn')}</a>
          </div>`}
        </form>`;
    }

    function passportFields() {
      return `
        <div class="field"><label>${t('auth.passportFileLabel')}</label><input class="input" id="f-passport-file" type="file" accept=".mcpass,application/json" required></div>
        <div class="field"><label>${t('auth.passportPassphraseLabel')}</label><input class="input" id="f-passport-pass" type="password" autocomplete="off" required></div>`;
    }

    function renderPassportLoginForm() {
      return `
        <h1>${t('auth.signInWithPassport')}</h1>
        <form id="auth-form" novalidate>
          ${passportFields()}
          <div id="captcha-slot"></div>
          <div class="error-text" id="auth-error"></div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">${t('auth.passportLoginButton')}</button>
          <div class="auth-switch"><a href="#" id="auth-back">${t('auth.backToPasswordLogin')}</a></div>
        </form>`;
    }

    function renderRecoverForm() {
      return `
        <h1>${t('auth.recoverTitle')}</h1>
        <p class="sub">${t('auth.recoverSub')}</p>
        <p class="sub" style="font-size:12px">${t('auth.recoverStrengthenNote')}</p>
        <form id="auth-form" novalidate>
          ${passportFields()}
          <div class="field"><label>${t('auth.newPasswordLabel')}</label><input class="input" name="newPassword" type="password" autocomplete="new-password" required></div>
          <div class="field"><label>${t('auth.authenticatorCodeOptional')}</label><input class="input" name="code" autocomplete="one-time-code"></div>
          <div id="captcha-slot"></div>
          <div class="error-text" id="auth-error"></div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">${t('auth.recoverButton')}</button>
          <div class="auth-switch"><a href="#" id="auth-back">${t('auth.backToPasswordLogin')}</a></div>
        </form>`;
    }

    function renderTotpForm() {
      return `
        <h1>${t('auth.twoFactorTitle')}</h1>
        <p class="sub">${t('auth.twoFactorSub')}</p>
        <form id="auth-form" novalidate>
          <div class="field" style="margin-bottom:8px">
            <label for="f-code">${t('auth.codeLabel')}</label>
            <input class="input" id="f-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autofocus required>
          </div>
          <div class="error-text" id="auth-error"></div>
          <button type="submit" class="btn btn-primary btn-block" id="auth-submit">${t('auth.verify')}</button>
          <div class="auth-switch"><a href="#" id="totp-back">${t('auth.backToLogin')}</a></div>
        </form>`;
    }

    async function onSubmit(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const errorBox = root.querySelector('#auth-error');
      const submitBtn = root.querySelector('#auth-submit');
      errorBox.textContent = '';

      const data = Object.fromEntries(new FormData(form).entries());
      if (mode === 'register' && (!data.password || data.password.length < MIN_PASSWORD_LENGTH)) {
        errorBox.textContent = t('auth.passwordTooShort');
        return;
      }

      if (cap && !cap.ready()) { errorBox.textContent = t('auth.captchaNeeded'); return; }
      const capFields = cap ? cap.payload() : {};
      submitBtn.disabled = true;
      submitBtn.textContent = mode === 'login' ? t('auth.loggingIn') : t('auth.registering');
      try {
        let res;
        let cred;
        if (mode === 'login') {
          const prepared = await prepareLogin(data.username, data.password);
          cred = prepared.cred;
          res = await api.login({ ...prepared.body, ...capFields });
          if (cred.mode === 'password' && res.user?.authMode === 'split') {
            try { await api.logout(); } catch { /* best effort */ }
            throw new Error(t('auth.signInParamsError'));
          }
        } else {
          const file = root.querySelector('#f-passport-file')?.files[0];
          const seed = file
            ? (await readFileWithPassphrase(file, root.querySelector('#f-passport-pass').value)).seed
            : await generateSeed();
          const keys = await deriveKeys(seed);
          cred = await splitCredential(data.password);
          // Explicit fields only: `data` also holds the password, which must never be sent.
          const account = {
            username: data.username, email: data.email, displayName: data.displayName, authKey: cred.authKey, authSalt: cred.authSalt, ...capFields,
            ...(regMode === 'invite' ? { inviteCode: inviteCodeFrom(data.inviteCode) } : {}),
          };
          let proof = null;
          try {
            proof = await proveWith(keys, 'register');
          } catch (err) {
            // The server does not recognise the address it is reached on (publicHost not configured),
            // so a Passport proof cannot be bound to it; sign up without one and attach later.
            if (err.status !== 400 || err.body?.error !== 'unrecognised server address') throw err;
          }
          if (proof) {
            res = await api.passportRegister({ ...account, ...(await passportBundle(seed, keys, cred)), ...proof });
            await cacheSeed(res.user.id, seed);
            if (!file) toast(t('auth.exportReminder'), { ttl: 12000 });
          } else {
            res = await api.register(account);
            await ensureIdentity(res.user, cred);
          }
        }
        if (res.requiresTotp) {
          pendingToken = res.pendingToken;
          pendingCred = cred;
          mode = 'totp';
          render();
          return;
        }
        if (mode === 'login') await ensureIdentity(res.user, cred);
        resolve(res.user);
      } catch (err) {
        errorBox.textContent = err.status === 409 && err.body?.username
          ? t('auth.passportAlreadyHere', { username: err.body.username })
          : captchaErrorMessage(err) || (PASSPORT_FILE_ERROR.test(err.message)
            ? t('auth.passportBadFile')
            : apiErrorMessage(err, t('auth.somethingWrong')));
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'login' ? t('auth.logIn') : t('auth.register');
        if (cap) cap.refresh();
      }
    }

    async function onSubmitPassportLogin(e) {
      e.preventDefault();
      const errorBox = root.querySelector('#auth-error');
      const submitBtn = root.querySelector('#auth-submit');
      errorBox.textContent = '';
      if (cap && !cap.ready()) { errorBox.textContent = t('auth.captchaNeeded'); return; }
      const capFields = cap ? cap.payload() : {};
      submitBtn.disabled = true;
      submitBtn.textContent = t('auth.passportWorking');
      try {
        const { seed, id } = await readFileWithPassphrase(root.querySelector('#f-passport-file').files[0], root.querySelector('#f-passport-pass').value);
        const keys = await deriveKeys(seed);
        const res = await api.passportLogin({ passportId: id, ...capFields, ...(await proveWith(keys, 'login')) });
        if (res.requiresTotp) {
          pendingToken = res.pendingToken;
          pendingSeed = seed;
          pendingCred = null;
          mode = 'totp';
          render();
          return;
        }
        await cacheSeed(res.user.id, seed);
        resolve(res.user);
      } catch (err) {
        errorBox.textContent = captchaErrorMessage(err) || (PASSPORT_FILE_ERROR.test(err.message)
          ? t('auth.passportBadFile') : apiErrorMessage(err, t('auth.somethingWrong')));
        submitBtn.disabled = false;
        submitBtn.textContent = t('auth.passportLoginButton');
        if (cap) cap.refresh();
      }
    }

    async function onSubmitRecover(e) {
      e.preventDefault();
      const errorBox = root.querySelector('#auth-error');
      const submitBtn = root.querySelector('#auth-submit');
      errorBox.textContent = '';
      const data = Object.fromEntries(new FormData(e.currentTarget).entries());
      if (!data.newPassword || data.newPassword.length < MIN_PASSWORD_LENGTH) { errorBox.textContent = t('auth.passwordTooShort'); return; }
      if (cap && !cap.ready()) { errorBox.textContent = t('auth.captchaNeeded'); return; }
      const capFields = cap ? cap.payload() : {};
      submitBtn.disabled = true;
      submitBtn.textContent = t('auth.passportWorking');
      try {
        const { seed, id } = await readFileWithPassphrase(root.querySelector('#f-passport-file').files[0], root.querySelector('#f-passport-pass').value);
        const keys = await deriveKeys(seed);
        const cred = await splitCredential(data.newPassword);
        const res = await api.passportRecover({
          passportId: id, newAuthKey: cred.authKey, newAuthSalt: cred.authSalt, backup: await wrapFor(seed, cred),
          code: data.code || undefined, ...capFields, ...(await proveWith(keys, 'recover')),
        });
        await cacheSeed(res.user.id, seed);
        toast(t('auth.passportRecovered'));
        resolve(res.user);
      } catch (err) {
        errorBox.textContent = captchaErrorMessage(err) || (PASSPORT_FILE_ERROR.test(err.message)
          ? t('auth.passportBadFile') : apiErrorMessage(err, t('auth.somethingWrong')));
        submitBtn.disabled = false;
        submitBtn.textContent = t('auth.recoverButton');
        if (cap) cap.refresh();
      }
    }

    async function onSubmitTotp(e) {
      e.preventDefault();
      const errorBox = root.querySelector('#auth-error');
      const submitBtn = root.querySelector('#auth-submit');
      const code = root.querySelector('#f-code').value.trim();
      errorBox.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = t('auth.verifying');
      try {
        const res = await api.login2fa(pendingToken, code);
        if (pendingSeed) { await cacheSeed(res.user.id, pendingSeed); pendingSeed = null; }
        else await ensureIdentity(res.user, pendingCred);
        pendingCred = null;
        resolve(res.user);
      } catch (err) {
        errorBox.textContent = apiErrorMessage(err, t('auth.invalidCode'));
        submitBtn.disabled = false;
        submitBtn.textContent = t('auth.verify');
      }
    }

    render();
  });
}
