export function createConsoleNavigation({ selectedTaskId, getHash, activate }) {
  let initialized = false;

  function activateFromLocation() {
    const hash = getHash();
    const selected = hash.slice(1) || (selectedTaskId ? 'records' : 'overview');
    activate(selected);
  }

  return {
    initialize() {
      if (initialized) return false;
      initialized = true;
      activateFromLocation();
      return true;
    },
    locationChanged() {
      initialized = true;
      activateFromLocation();
    },
  };
}
