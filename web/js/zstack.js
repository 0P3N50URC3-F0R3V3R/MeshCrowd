// Shared stacking-order counter so nested/sequential overlays (settings panel -> edit-channel
// modal -> delete confirmation, etc.) always render in the order they were opened, regardless
// of which CSS class each one uses. Every overlay-creating function must call this and apply
// the result as an inline z-index (inline always wins over the stylesheet default).
let counter = 1000;

export function nextZIndex() {
  counter += 10;
  return counter;
}
