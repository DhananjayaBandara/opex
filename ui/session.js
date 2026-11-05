// The signed-in state of the page. It holds the contexts issued by the services (never a tenant id
// from the URL), and turns the services' "this session is over" refusals into a return to sign-in or
// to the entry chooser, with a notice. Browser-only state; contexts live in memory, so a reload
// signs the person out (level S, decision D18).

const SIGN_OUT_CODES = new Set(["session_ended", "invalid_context"]);
const DROP_CODES = new Set(["tenant_inactive", "access_revoked", "support_expired"]);

const listeners = new Set();
let app = null;
const state = { userCtx: null, user: null, ctx: null, who: null, platformCtx: null, notice: null };

function emit() {
  for (const listener of [...listeners]) listener();
}

function reset(notice = null) {
  state.userCtx = null;
  state.user = null;
  state.ctx = null;
  state.who = null;
  state.platformCtx = null;
  state.notice = notice;
}

export const session = {
  init(instance) {
    app = instance;
    reset();
    emit();
  },
  onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get app() {
    return app;
  },
  get signedIn() {
    return state.userCtx !== null;
  },
  get inside() {
    return state.ctx !== null;
  },
  get user() {
    return state.user;
  },
  get who() {
    return state.who;
  },
  get ctx() {
    return state.ctx;
  },
  get notice() {
    return state.notice;
  },
  get kind() {
    return state.who?.kind ?? null;
  },
  get supporting() {
    return (
      state.who?.kind === "tenant" && state.who.support !== null && state.who.support !== undefined
    );
  },
  can(permission) {
    return state.who?.permissions?.includes(permission) === true;
  },
  clearNotice() {
    state.notice = null;
  },

  // Runs a service call with the current context. A refusal that ends the session is turned into a
  // sign-out (or a return to the chooser) before the error is passed on.
  run(call) {
    try {
      return call(state.ctx);
    } catch (error) {
      this.handle(error);
      throw error;
    }
  },
  handle(error) {
    if (SIGN_OUT_CODES.has(error?.code)) {
      reset(error.message);
      emit();
    } else if (DROP_CODES.has(error?.code) && state.ctx !== null) {
      state.ctx = null;
      state.who = null;
      state.notice = error.message;
      emit();
    }
  },

  // Returns { mfaRequired: true } when the account needs the simulated code.
  signIn({ email, mfaCode }) {
    try {
      const userCtx = app.identity.authenticate({ email, mfaCode });
      reset();
      state.userCtx = userCtx;
      state.user = app.identity.whoami(userCtx);
      emit();
      return { mfaRequired: false };
    } catch (error) {
      if (error.code === "mfa_required") return { mfaRequired: true };
      throw error;
    }
  },
  choices() {
    const organizations = app.identity.organizations(state.userCtx);
    return { platform: state.user?.platformAccess === true, organizations };
  },
  // Goes straight in when there is only one place to go.
  autoEnter() {
    const { platform, organizations } = this.choices();
    if (!platform && organizations.length === 1) this.enterTenant(organizations[0].slug);
  },
  enterTenant(slug) {
    state.ctx = app.identity.enterTenant(state.userCtx, { slug });
    state.who = app.identity.whoami(state.ctx);
    state.platformCtx = null;
    state.notice = null;
    emit();
  },
  enterPlatform() {
    state.ctx = app.identity.enterPlatform(state.userCtx);
    state.who = app.identity.whoami(state.ctx);
    state.notice = null;
    emit();
  },
  // A platform user enters a tenant through an approved support grant (read-only).
  enterSupport(grantId) {
    const platformCtx = state.ctx;
    const ctx = app.support.enter(platformCtx, grantId);
    state.platformCtx = platformCtx;
    state.ctx = ctx;
    state.who = app.identity.whoami(ctx);
    emit();
  },
  leaveSupport() {
    if (state.platformCtx === null) return;
    state.ctx = state.platformCtx;
    state.platformCtx = null;
    state.who = app.identity.whoami(state.ctx);
    emit();
  },
  // Back to the entry chooser without signing out.
  switchEntry() {
    state.ctx = null;
    state.who = null;
    state.platformCtx = null;
    emit();
  },
  // Re-reads who the person is (their permissions may have changed).
  refresh() {
    if (state.ctx === null) return;
    try {
      state.who = app.identity.whoami(state.ctx);
    } catch (error) {
      this.handle(error);
      return;
    }
    emit();
  },
  signOut(notice = null) {
    try {
      if (state.userCtx !== null) app.identity.signOut(state.userCtx);
    } catch {
      // the session may already be over
    }
    reset(notice);
    emit();
  },
  // After the data was reset or replaced: forget every context.
  forget(instance, notice = null) {
    app = instance;
    reset(notice);
    emit();
  },
};
