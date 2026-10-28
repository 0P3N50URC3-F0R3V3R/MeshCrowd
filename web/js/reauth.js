let gate = null;

export const setReauthGate = (fn) => { gate = fn; };
export const passReauth = () => (gate ? gate() : Promise.resolve(true));
